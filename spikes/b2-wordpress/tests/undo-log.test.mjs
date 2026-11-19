// node --test spikes/b2-wordpress/tests/undo-log.test.mjs (#352, #577, and #60's first CI coverage).
// undo-log.mjs on node:sqlite through an adapter shaped like the Durable Object's ctx.storage.sql
// (exec(sql, ...params) -> a cursor with raw(), one(), toArray(), columnNames, rowsWritten) and
// ctx.storage.transactionSync. A "new isolate" is a NEW createUndoLog on the SAME database: what the
// module keeps in memory is gone, as after an isolate reset; what SQLite stored stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createUndoLog, mayWrite, isDdl, pluginStatusWrite } from '../undo-log.mjs';

function objectSql(onExec) {
	const d = new DatabaseSync(':memory:');
	const cursor = (rows, cols, changes) => ({
		columnNames: cols,
		rowsRead: rows.length,
		rowsWritten: changes,
		raw: () => rows[Symbol.iterator](),
		toArray: () => rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]]))),
		one: () => Object.fromEntries(cols.map((c, i) => [c, rows[0][i]])),
	});
	// sqlite_sequence is not in total_changes(). The Durable Object bills that update as a row
	// written, one per insert into an AUTOINCREMENT table (#577). onExec sees both.
	const seqOf = () => {
		try {
			const r = d.prepare("SELECT seq FROM sqlite_sequence WHERE name = '_wp_undo'").get();
			return r ? r.seq : null;
		} catch {
			return null;
		}
	};
	const exec = (sql, ...params) => {
		const seqBefore = onExec ? seqOf() : null;
		const changesBefore = onExec ? d.prepare('SELECT total_changes() AS c').get().c : 0;
		const st = d.prepare(sql);
		const cols = st.columns().map((c) => c.name);
		let cur;
		if (cols.length) {
			st.setReturnArrays(true);
			cur = cursor(st.all(...params), cols, 0);
		} else {
			cur = cursor([], [], st.run(...params).changes);
		}
		if (onExec) {
			const logical = d.prepare('SELECT total_changes() AS c').get().c - changesBefore;
			onExec({ logical, seq: seqOf() === seqBefore ? 0 : 1 });
		}
		return cur;
	};
	const storage = {
		transactionSync(fn) {
			d.exec('SAVEPOINT ts');
			try { const r = fn(); d.exec('RELEASE ts'); return r; } catch (e) { d.exec('ROLLBACK TO ts'); d.exec('RELEASE ts'); throw e; }
		},
	};
	return { db: { exec, storage }, storage, raw: d };
}
function isolate(frames = true) {
	const dropped = [];
	const logs = [];
	const stats = { txnOps: 0, undoRows: 0 };
	const u = createUndoLog({ stats, objectCacheDrop: (k) => dropped.push(k), log: (o) => logs.push(o), frames });
	return { u, stats, dropped, logs };
}
// What PHP's statements do through index.js sqlStatement: the statement runs inside u.statement(), which
// opens the frame just before it when it may write, and takes the open back if it changed nothing.
// The reply is shaped like sqlStatement's: changes from total_changes(), last_row_id after an insert.
function reply(db, sql, cur) {
	return { changes: cur.changes, last_row_id: cur.changes > 0 && /^\s*(INSERT|REPLACE)\b/i.test(sql) ? db.exec('SELECT last_insert_rowid() AS r').one().r : 0 };
}
function run(u, db, sql, ...p) {
	const storage = db.storage;
	return u.statement(db, storage, sql, () => {
		const before = db.exec('SELECT total_changes() AS c').one().c;
		const cur = db.exec(sql, ...p);
		const after = db.exec('SELECT total_changes() AS c').one().c;
		cur.changes = after === before ? 0 : db.exec('SELECT changes() AS c').one().c;
		u.afterStatement(db, sql, cur.rowsWritten);
		return cur;
	}, p);
}
const ids = (db) => [...db.exec('SELECT v FROM t ORDER BY id').raw()].map((r) => r[0]);
function site() {
	const s = objectSql();
	s.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
	s.db.exec("INSERT INTO t (v) VALUES ('seed')");
	return s;
}

test('mayWrite: reads and statements that change no covered row never open a frame; everything else does (conservative)', () => {
	// A PRAGMA (a setter too), VACUUM, ANALYZE and REINDEX change no row of a table the undo triggers cover
	// (CI at 105776b: a PRAGMA opened the frame of 10 of 10 public GETs). They must also never run inside the
	// opening transaction: SQLite ignores PRAGMA foreign_keys there, and VACUUM refuses to run in one.
	for (const q of ['SELECT 1', ' select * from t', 'EXPLAIN SELECT 1', 'PRAGMA table_info(t)', 'PRAGMA foreign_keys', 'PRAGMA foreign_keys = ON', ' pragma journal_mode=WAL;', 'VACUUM', 'ANALYZE', 'REINDEX t']) assert.equal(mayWrite(q), false, q);
	for (const q of ['INSERT INTO t VALUES (1)', 'UPDATE t SET v = 1', 'DELETE FROM t', 'REPLACE INTO t VALUES (1)', 'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x', 'SELECT 1 RETURNING 1', 'CREATE TABLE z (a)']) assert.equal(mayWrite(q), true, q);
	assert.equal(isDdl('CREATE TABLE z (a)'), true);
	assert.equal(isDdl('INSERT INTO t VALUES (1)'), false);
});

test('LAZY: a request that only reads never opens a frame (it pays nothing)', () => {
	const { db } = site();
	const { u } = isolate();
	u.arm(db, 'r1');
	run(u, db, 'SELECT * FROM t');
	assert.equal(u.frameOpen(), false);
	u.end(db);
	assert.equal(u.status(db, 'r1'), null, 'no frame row at all');
});

test('the FIRST write opens the frame; a reset (a new isolate) rolls the whole request back', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r2');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	assert.equal(a.u.frameOpen(), true);
	run(a.u, db, "UPDATE t SET v = 'seed2' WHERE v = 'seed'");
	run(a.u, db, "INSERT INTO t (v) VALUES ('B')");
	// The isolate dies here: no end(). The next one recovers first.
	const b = isolate();
	b.u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed'], 'A, B and the update are all undone');
	assert.deepEqual({ ...b.u.status(db, 'r2'), t: 0 }, { req: 'r2', state: 'rolled-back', points: 0, kinds: '', undone: 3, t: 0 });
});

test('a request that FINISHES keeps its writes, and a later recovery undoes nothing', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r3');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	a.u.end(db);
	assert.equal(a.u.frameOpen(), false);
	const b = isolate();
	b.u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed', 'A']);
	assert.equal(b.u.status(db, 'r3').state, 'kept');
});

test('PHP transactions inside a frame are savepoints: a PHP ROLLBACK undoes only its part, the frame stays', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r4');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('P')");
	a.u.txnOp(db, storage, { op: 'rollback' });
	assert.deepEqual(ids(db), ['seed', 'A'], 'only the PHP transaction was undone');
	assert.equal(a.u.frameOpen(), true, 'the frame is still open');
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('Q')");
	a.u.txnOp(db, storage, { op: 'commit' });
	assert.equal(a.u.frameOpen(), true, 'a PHP COMMIT does not commit the frame');
	const b = isolate();
	b.u.recover(db, storage); // the isolate died before end(): the whole request goes
	assert.deepEqual(ids(db), ['seed']);
});

test('a PHP transaction still open at the end is rolled back (MySQL on close); the frame is then kept', () => {
	const { db } = site();
	const a = isolate();
	a.u.arm(db, 'r5');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	a.u.txnOp(db, objectSql().storage, { op: 'begin' }); // a storage object is only used by undo
	run(a.u, db, "INSERT INTO t (v) VALUES ('P')");
	a.u.end(db, { transactionSync: (fn) => fn() });
	assert.deepEqual(ids(db), ['seed', 'A']);
	assert.equal(a.u.status(db, 'r5').state, 'kept');
});

test('a COMMIT POINT keeps what came before it: a reset after it rolls back only what came after', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r6');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	a.u.commitPoint(db, 'http');
	assert.equal(a.u.frameOpen(), false, 'closed as kept; the next write opens a new frame');
	run(a.u, db, "INSERT INTO t (v) VALUES ('B')");
	const b = isolate();
	b.u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed', 'A']);
	const st = b.u.status(db, 'r6');
	assert.equal(st.state, 'rolled-back');
	assert.equal(st.points, 1);
	assert.equal(st.kinds, 'http');
});

test('DDL inside a frame is a commit point (MySQL implicit commit); the new table is covered next frame', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r7');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	run(a.u, db, 'CREATE TABLE n (id INTEGER PRIMARY KEY, w TEXT)');
	assert.equal(a.u.status(db, 'r7').points, 1);
	run(a.u, db, "INSERT INTO n (w) VALUES ('N')");
	const b = isolate();
	b.u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed', 'A'], 'before the DDL: kept');
	assert.equal(db.exec('SELECT COUNT(*) AS c FROM n').one().c, 0, 'the new table has triggers: its insert was undone');
});

test('the MISS guard: a write while armed with no frame open is counted and logged, never silent', () => {
	const { db } = site();
	const a = isolate();
	a.u.arm(db, 'r8');
	const cur = db.exec("INSERT INTO t (v) VALUES ('X')"); // bypasses beforeStatement on purpose
	a.u.afterStatement(db, 'INSERT INTO t', cur.rowsWritten);
	assert.equal(a.u.counts().miss, 1);
	assert.ok(a.logs.some((l) => l.m === 'frame-miss'));
});

test('deferred work (the KV L2 sets) runs only when the frame is KEPT, never after a reset', () => {
	const { db, storage } = site();
	const ran = [];
	const a = isolate();
	a.u.arm(db, 'r9');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	assert.equal(a.u.defer(() => ran.push('l2-a')), true, 'deferred: a frame is open');
	a.u.end(db);
	assert.deepEqual(ran, ['l2-a']);
	const b = isolate();
	b.u.arm(db, 'r10');
	run(b.u, db, "INSERT INTO t (v) VALUES ('B')");
	b.u.defer(() => ran.push('l2-b'));
	const c = isolate();
	c.u.recover(db, storage); // b died: its deferred work never ran
	assert.deepEqual(ran, ['l2-a']);
	assert.equal(isolate().u.defer(() => ran.push('now')), false, 'no frame: the caller runs it at once');
});

test('ROW-ID REUSE: a rolled-back insert id is reused; after a commit point it is not', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r11');
	const id1 = Number(run(a.u, db, "INSERT INTO t (v) VALUES ('A') RETURNING id").raw().next().value[0]);
	isolate().u.recover(db, storage);
	const b = isolate();
	b.u.arm(db, 'r12');
	const id2 = Number(run(b.u, db, "INSERT INTO t (v) VALUES ('A2') RETURNING id").raw().next().value[0]);
	assert.equal(id2, id1, 'REUSED: INTEGER PRIMARY KEY without AUTOINCREMENT takes max(rowid) + 1');
	// The commit-point rule: an id an outside party may hold is KEPT, so it is never handed out again.
	b.u.commitPoint(db, 'http');
	isolate().u.recover(db, storage);
	const c = isolate();
	c.u.arm(db, 'r13');
	const id3 = Number(run(c.u, db, "INSERT INTO t (v) VALUES ('A3') RETURNING id").raw().next().value[0]);
	assert.equal(id3, id2 + 1, 'kept before the commit point: not reused');
});

test('FRAMES OFF: #60 semantics exactly (begin, commit, rollback, savepoints, open-at-end, recover)', () => {
	const { db, storage } = site();
	const a = isolate(false);
	a.u.arm(db, 'x'); // a no-op with frames off
	run(a.u, db, "INSERT INTO t (v) VALUES ('auto')");
	assert.equal(a.u.frameOpen(), false);
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('r')");
	a.u.txnOp(db, storage, { op: 'rollback' });
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('c')");
	a.u.txnOp(db, storage, { op: 'commit' });
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('s1')");
	a.u.txnOp(db, storage, { op: 'savepoint', name: 'p' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('s2')");
	a.u.txnOp(db, storage, { op: 'rollback_to', name: 'p' });
	a.u.txnOp(db, storage, { op: 'commit' });
	assert.deepEqual(ids(db), ['seed', 'auto', 'c', 's1']);
	assert.deepEqual(a.u.txnOp(db, storage, { op: 'rollback_to', name: 'nope' }), { ok: true }, 'outside a transaction: a no-op, as MySQL autocommit');
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('open')");
	const b = isolate(false);
	b.u.recover(db, storage); // the isolate died with a PHP transaction open
	assert.deepEqual(ids(db), ['seed', 'auto', 'c', 's1']);
});

test('status keeps a short history: the probe for a request still answers after a few more requests', () => {
	const { db } = site();
	const a = isolate();
	for (let i = 0; i < 5; i++) { a.u.arm(db, 'h' + i); run(a.u, db, "INSERT INTO t (v) VALUES ('h')"); a.u.end(db); }
	assert.equal(a.u.status(db, 'h0').state, 'kept');
	assert.equal(a.u.status(db, 'nope'), null);
});

// Found by a mutant that survived (the frame's durable active flag left at 0 after a PHP ROLLBACK):
// a PLAIN write after a PHP rollback inside a frame must still be logged, and undone by a reset.
test('after a PHP ROLLBACK inside a frame, a plain write is still logged and a reset undoes it', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r14');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('P')");
	a.u.txnOp(db, storage, { op: 'rollback' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('AFTER')");
	assert.equal(db.exec('SELECT active FROM _wp_undo_state WHERE id = 1').one().active, 1, 'the durable flag is still 1');
	isolate().u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed'], 'A and AFTER are undone: the frame logged both');
});

test('shapeOf names the verb and table of the statement that opened a frame, never its values', async () => {
	const { shapeOf } = await import('../undo-log.mjs');
	assert.equal(shapeOf("INSERT OR IGNORE INTO wp_options (a) VALUES ('secret')"), 'INSERT OR IGNORE wp_options');
	assert.equal(shapeOf("UPDATE wp_options SET option_value = 'x' WHERE option_name = 'y'"), 'UPDATE wp_options');
	assert.equal(shapeOf('DELETE FROM wp_woocommerce_sessions WHERE session_expiry < 5'), 'DELETE wp_woocommerce_sessions');
	assert.equal(shapeOf("INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO NOTHING"), 'INSERT t ON CONFLICT');
	assert.equal(shapeOf('PRAGMA foreign_keys = ON'), 'PRAGMA foreign_keys');
	const { db } = site();
	const a = isolate();
	a.u.arm(db, 'by1');
	run(a.u, db, "UPDATE t SET v = 'x' WHERE v = 'seed'");
	assert.equal(a.u.openedBy(), 'UPDATE t');
});

// #352 laziness (CI red at 8d557c7: 10 of 10 public GETs opened a frame with 0 rows written). The open,
// the statement and its first undo row run in ONE storage transaction; a statement that changed no row
// takes the open back, so it commits nothing durable.
// No undo tables at all (the open was taken back before anything else created them) is active 0 too.
const activeFlag = (db) => { try { return db.exec('SELECT active FROM _wp_undo_state WHERE id = 1').one().active; } catch { return 0; } };
const frameRows = (db) => { try { return db.exec('SELECT COUNT(*) AS n FROM _wp_frame').one().n; } catch { return 0; } };
const NOOPS = ["UPDATE t SET v = 'x' WHERE v = 'none'", "DELETE FROM t WHERE v = 'none'", "INSERT OR IGNORE INTO t (id, v) VALUES (1, 'dup')"];

test('NO-OP WRITE: a write statement that changes no row leaves no frame (no _wp_frame row, active 0)', () => {
	for (const sql of NOOPS) {
		const { db } = site();
		const { u } = isolate();
		u.arm(db, 'n1');
		run(u, db, sql);
		assert.equal(u.frameOpen(), false, sql);
		u.end(db);
		assert.equal(u.status(db, 'n1'), null, 'no frame row: ' + sql);
		assert.equal(frameRows(db), 0, sql);
		assert.equal(activeFlag(db), 0, sql);
		assert.equal(u.counts().opened, 0, sql);
		assert.equal(u.counts().noop, 1, sql);
	}
});

test('NO-OP WRITE: what PHP sees is identical to frames off (changes 0, last insert id, no error)', () => {
	for (const sql of NOOPS) {
		const on = site();
		const off = site();
		const a = isolate(true);
		const b = isolate(false);
		a.u.arm(on.db, 'n2');
		b.u.arm(off.db, 'n2');
		// A real insert first on both, outside any frame, so last_insert_rowid has a value to keep.
		on.db.exec("INSERT INTO t (v) VALUES ('pre')");
		off.db.exec("INSERT INTO t (v) VALUES ('pre')");
		const rOn = run(a.u, on.db, sql);
		const rOff = run(b.u, off.db, sql);
		assert.deepEqual(reply(on.db, sql, rOn), reply(off.db, sql, rOff), sql);
		assert.equal(rOn.changes, 0, sql);
		assert.equal(on.db.exec('SELECT changes() AS c').one().c, off.db.exec('SELECT changes() AS c').one().c, 'changes(): ' + sql);
		assert.deepEqual(ids(on.db), ids(off.db), sql);
	}
});

test('NO-OP then a REAL write: the real write opens the frame and a reset rolls it back', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'n3');
	run(a.u, db, NOOPS[0]);
	assert.equal(a.u.frameOpen(), false);
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	assert.equal(a.u.frameOpen(), true);
	assert.equal(a.u.openedBy(), 'INSERT t');
	isolate().u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed']);
});

test('an UNDO ROW decides, not the reported row count: a write reported as 0 rows keeps its frame', () => {
	// The adapter reports rowsWritten 0 for a statement that returns rows (RETURNING), as a counter could
	// under-report: the trigger still logged the before-image, so the frame must stay and cover it.
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'n4');
	const cur = run(a.u, db, "UPDATE t SET v = 'changed' WHERE v = 'seed' RETURNING id");
	assert.equal(cur.rowsWritten, 0, 'the instrument under-reports here, by construction');
	assert.equal(a.u.frameOpen(), true, 'the undo row keeps the frame');
	isolate().u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed'], 'the RETURNING update is undone');
});

test('a statement that THROWS inside the opening transaction takes the open back and rethrows the same error', () => {
	const { db } = site();
	const { u } = isolate();
	u.arm(db, 'n5');
	assert.throws(() => run(u, db, 'UPDATE no_such_table SET v = 1'), /no_such_table/);
	assert.equal(u.frameOpen(), false);
	assert.equal(frameRows(db), 0);
	assert.equal(activeFlag(db), 0);
});

test('a PRAGMA setter while armed opens no frame and still TAKES EFFECT (it never runs inside a transaction)', () => {
	const { db } = site();
	const { u } = isolate();
	u.arm(db, 'n6');
	// node:sqlite starts with foreign keys ON, so the setter that can be seen to change something is OFF.
	assert.equal(db.exec('PRAGMA foreign_keys').one().foreign_keys, 1, 'the instrument: it starts ON');
	run(u, db, 'PRAGMA foreign_keys = OFF');
	assert.equal(u.frameOpen(), false);
	assert.equal(db.exec('PRAGMA foreign_keys').one().foreign_keys, 0, 'the setting held');
	u.end(db);
	assert.equal(frameRows(db), 0);
	assert.equal(u.counts().opened, 0);
});

// pf352f, 2026-11-14: the deployed object never armed a frame. index.js created the one undo log per
// isolate at its FIRST use, and in a deployed object that is the PhpRuntime constructor's recovery, before
// any fetch has set ENV: frames was decided false for the whole isolate. Local workerd hid it (the Worker's
// fetch shares the isolate and sets ENV first). frames may be a function, asked when it matters.
test('frames as a FUNCTION is asked at arm time, not at creation (the undo log may be made before env is known)', () => {
	const { db, storage } = site();
	let on = false;
	const stats = { txnOps: 0, undoRows: 0 };
	const u = createUndoLog({ stats, frames: () => on });
	assert.equal(u.recover(db, storage), null, 'recovery first, as in the constructor, with frames still unknown');
	u.arm(db, 'f0');
	run(u, db, "INSERT INTO t (v) VALUES ('OFF')");
	assert.equal(u.frameOpen(), false, 'the function says off: no frame (a function is not truthy-on)');
	u.end(db);
	db.exec("DELETE FROM t WHERE v = 'OFF'");
	on = true;
	u.arm(db, 'f1');
	run(u, db, "INSERT INTO t (v) VALUES ('A')");
	assert.equal(u.frameOpen(), true, 'the frame opens: frames was read when the request armed');
	const b = createUndoLog({ stats, frames: () => true });
	b.recover(db, storage);
	assert.deepEqual(ids(db), ['seed']);
	assert.equal(b.status(db, 'f1').state, 'rolled-back');
});

test('recovery ALWAYS logs one line, also when nothing was open (a blind spot otherwise)', () => {
	const { db, storage } = site();
	const logs = [];
	const u = createUndoLog({ stats: { txnOps: 0, undoRows: 0 }, log: (o) => logs.push(o), frames: true });
	u.recover(db, storage);
	assert.equal(logs.filter((l) => l.m === 'frame-recover').length, 1, JSON.stringify(logs));
	assert.equal(logs[0].active, 0);
	assert.equal(logs[0].frames, true);
});

test('a frame open logs one line once it is COMMITTED (never for a no-op that took the open back)', () => {
	const { db } = site();
	const logs = [];
	const u = createUndoLog({ stats: { txnOps: 0, undoRows: 0 }, log: (o) => logs.push(o), frames: true });
	u.arm(db, 'f3');
	run(u, db, "UPDATE t SET v = 'x' WHERE v = 'none'");
	assert.equal(logs.filter((l) => l.m === 'frame-open').length, 0);
	run(u, db, "INSERT INTO t (v) VALUES ('A')");
	assert.deepEqual(logs.filter((l) => l.m === 'frame-open').map((l) => [l.req, l.by]), [['f3', 'INSERT t']]);
});

// The lead asked for the frame's OWN rows: x-db-rows counts PHP's statements (their undo-trigger rows
// included), never the frame's own (the open, the close, the history, the log cleared at close).
test('counts.own: the rows the frame itself writes, exactly; a no-op that took its open back adds none', () => {
	const { db } = site();
	const { u } = isolate();
	u.arm(db, 'o1');
	run(u, db, NOOPS[0]);
	assert.equal(u.counts().own, 0, 'the taken-back open is not counted');
	run(u, db, "INSERT INTO t (v) VALUES ('A')");
	run(u, db, "INSERT INTO t (v) VALUES ('B')");
	const atOpen = u.counts().own;
	// open: active 0 -> 1 (1) + the _wp_frame row (1) (+ the undo-state seed row the first time: 1)
	assert.ok(atOpen >= 2 && atOpen <= 3, 'open: ' + atOpen);
	u.end(db);
	// close: active 1 -> 0 (1) + the 2 undo rows cleared (2) + the _wp_frame row updated (1)
	assert.equal(u.counts().own - atOpen, 4, 'close');
});

// The lead's ruling (pf352f point case, 2026-11-14): a request killed after a commit point, with no write
// after it, left its frame row 'open' (frameKeep writes 'open' at a point; nothing was active, so recovery
// had nothing to undo or relabel). Relabel at RECOVERY: a row still 'open' when an isolate starts belongs
// to a request of a dead isolate. That costs a write only after a reset, never on the normal path.
test('RECOVERY relabels a frame left open by a dead isolate (point case): ended-at-reset, never open', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'e1');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	a.u.commitPoint(db, 'ddl');
	assert.equal(a.u.status(db, 'e1').state, 'open', 'the instrument: open while the request runs');
	// The isolate dies here, after the point and before any further write: nothing is active.
	const logs = [];
	const b = createUndoLog({ stats: { txnOps: 0, undoRows: 0 }, log: (o) => logs.push(o), frames: true });
	b.recover(db, storage);
	assert.deepEqual(ids(db), ['seed', 'A'], 'A, before the point, is kept');
	const s = b.status(db, 'e1');
	assert.equal(s.state, 'ended-at-reset');
	assert.equal(s.points, 1);
	assert.equal(s.undone, 0);
	assert.equal(logs.find((l) => l.m === 'frame-recover').relabeled, 1);
});

test('RECOVERY with an active frame: the rolled-back one is labeled rolled-back, an older open one ended-at-reset', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'e2');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	a.u.commitPoint(db, 'ddl'); // e2 left 'open' (its isolate will die below without recovery seeing it)
	// a second isolate never ran recovery for e2 (as if frames were off then): simulate with a later request
	const c = isolate();
	c.u.arm(db, 'e3');
	run(c.u, db, "INSERT INTO t (v) VALUES ('B')");
	isolate().u.recover(db, storage);
	assert.equal(isolate().u.status(db, 'e3').state, 'rolled-back');
	assert.equal(isolate().u.status(db, 'e2').state, 'ended-at-reset');
});

test('a clean request never pays the relabel: recovery with nothing open writes no frame row', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'e4');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	a.u.end(db);
	const b = isolate();
	b.u.recover(db, storage);
	assert.equal(b.u.counts().own, 0, 'no row written by a recovery that found nothing');
	assert.equal(b.u.status(db, 'e4').state, 'kept');
});

// A mutation gap (ROLLBACK TO dropping its own savepoint survived the suite), and the case a seq REUSE
// would break: after ROLLBACK TO p clears the log above p, new rows may take the cleared seqs (they always
// do without AUTOINCREMENT). Savepoints that are still live hold seqs at or below the log's top, so new rows
// are always above every one of them.
test('ROLLBACK TO the same savepoint twice, with writes and an inner savepoint between (seq reuse is safe)', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 's1');
	run(a.u, db, "INSERT INTO t (v) VALUES ('pre')");
	a.u.txnOp(db, storage, { op: 'begin' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('in')");
	a.u.txnOp(db, storage, { op: 'savepoint', name: 'p' });
	run(a.u, db, "INSERT INTO t (v) VALUES ('X')");
	assert.deepEqual(a.u.txnOp(db, storage, { op: 'rollback_to', name: 'p' }), { ok: true, undone: 1 });
	run(a.u, db, "INSERT INTO t (v) VALUES ('Y')"); // may reuse X's seq
	a.u.txnOp(db, storage, { op: 'savepoint', name: 'q' });
	run(a.u, db, "UPDATE t SET v = 'Y2' WHERE v = 'Y'");
	run(a.u, db, "INSERT INTO t (v) VALUES ('Z')");
	assert.deepEqual(a.u.txnOp(db, storage, { op: 'rollback_to', name: 'q' }), { ok: true, undone: 2 });
	assert.deepEqual(ids(db), ['seed', 'pre', 'in', 'Y'], 'q undid Z and the update, Y stays');
	assert.deepEqual(a.u.txnOp(db, storage, { op: 'rollback_to', name: 'p' }), { ok: true, undone: 1 }, 'p is still live after its first ROLLBACK TO');
	assert.deepEqual(ids(db), ['seed', 'pre', 'in']);
	a.u.txnOp(db, storage, { op: 'commit' });
	// The frame still covers all of it: a reset now rolls back to before 'pre'.
	isolate().u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed']);
});

// #577. A framed save's billed rows are total_changes() plus one sqlite_sequence update per undo
// insert. The Durable Object's rowsWritten counts that sequence row; node:sqlite's changes() does not.
// Three covered writes on a warm database: 6 logical rows through the statement (the user row and its
// undo row, each) plus 7 of the frame's own (active on, the frame row, active off, the 3 undo rows
// cleared, the frame row updated) = 13. AUTOINCREMENT adds 3, billed 16. The plain rowid bills 13.
function meteredSite() {
	const tally = { logical: 0, seqWrites: 0 };
	const s = objectSql((delta) => {
		tally.logical += delta.logical;
		tally.seqWrites += delta.seq;
	});
	s.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
	s.db.exec("INSERT INTO t (v) VALUES ('seed')");
	s.tally = tally;
	return s;
}
test('a framed save bills the logical rows only: no sqlite_sequence write (#577)', () => {
	const { db, tally } = meteredSite();
	const a = isolate();
	a.u.arm(db, 'warm');
	run(a.u, db, "INSERT INTO t (v) VALUES ('w')");
	a.u.end(db);
	const base = { logical: tally.logical, seqWrites: tally.seqWrites, own: a.u.counts().own };
	a.u.arm(db, 'save');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	run(a.u, db, "UPDATE t SET v = 'seed2' WHERE v = 'seed'");
	run(a.u, db, "DELETE FROM t WHERE v = 'A'");
	a.u.end(db);
	const logical = tally.logical - base.logical;
	const seqWrites = tally.seqWrites - base.seqWrites;
	const own = a.u.counts().own - base.own;
	assert.deepEqual(ids(db), ['seed2', 'w'], 'the save kept its writes');
	// billed is what x-db-rows plus the frame's own rows cost. seqWrites is the AUTOINCREMENT tax.
	assert.deepEqual(
		{ billed: logical + seqWrites, logical, seqWrites, own },
		{ billed: 13, logical: 13, seqWrites: 0, own: 7 },
	);
});

// Within one frame that only appends, seq order is insertion order, so newest-first does not need
// AUTOINCREMENT's never-reuse rule. Two updates of one row prove the replay order: oldest-first would
// leave the intermediate value.
test('undo restores the exact pre-request state, newest first (#577)', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'ord');
	run(a.u, db, "UPDATE t SET v = 'X' WHERE v = 'seed'");
	run(a.u, db, "UPDATE t SET v = 'Y' WHERE v = 'X'");
	const logged = [...db.exec('SELECT sql FROM _wp_undo ORDER BY seq DESC').raw()].map((r) => r[0]);
	assert.equal(logged.length, 2);
	assert.match(logged[0], /'X'/, 'the newer undo runs first: it puts the intermediate value back');
	assert.match(logged[1], /'seed'/, 'then the original');
	isolate().u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed']);
});

// After ROLLBACK TO deletes the tail, a plain rowid reuses the cleared seq. The new row is the one
// a later undo applies. AUTOINCREMENT would hand out a fresh seq; the replay does not need that.
test('a cleared undo seq is reused, and the new row is what a later undo applies (#577)', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'reuse');
	run(a.u, db, "INSERT INTO t (v) VALUES ('pre')");
	run(a.u, db, "INSERT INTO t (v) VALUES ('in')");
	a.u.txnOp(db, storage, { op: 'begin' });
	a.u.txnOp(db, storage, { op: 'savepoint', name: 'p' });
	run(a.u, db, "DELETE FROM t WHERE v = 'in'");
	const cleared = db.exec('SELECT MAX(seq) AS s FROM _wp_undo').one().s;
	assert.match(db.exec('SELECT sql FROM _wp_undo WHERE seq = ?', cleared).one().sql, /'in'/);
	assert.deepEqual(a.u.txnOp(db, storage, { op: 'rollback_to', name: 'p' }), { ok: true, undone: 1 });
	run(a.u, db, "DELETE FROM t WHERE v = 'pre'");
	const again = db.exec('SELECT MAX(seq) AS s FROM _wp_undo').one().s;
	const againSql = db.exec('SELECT sql FROM _wp_undo WHERE seq = ?', again).one().sql;
	assert.equal(again, cleared, 'plain rowid reuses the cleared seq');
	assert.match(againSql, /'pre'/);
	assert.doesNotMatch(againSql, /'in'/);
	assert.deepEqual(a.u.txnOp(db, storage, { op: 'rollback_to', name: 'p' }), { ok: true, undone: 1 });
	assert.deepEqual(ids(db), ['seed', 'pre', 'in'], 'the reused seq undid the new delete, not the old one');
	isolate().u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed'], 'the whole frame still rolls back to the pre-request row');
});

function oldUndo(raw) {
	raw.exec('CREATE TABLE _wp_undo (seq INTEGER PRIMARY KEY AUTOINCREMENT, sql TEXT NOT NULL)');
	raw.exec('CREATE TABLE _wp_undo_state (id INTEGER PRIMARY KEY CHECK (id = 1), active INTEGER NOT NULL)');
	raw.exec('INSERT INTO _wp_undo_state (id, active) VALUES (1, 0)');
}
function undoDdl(raw) {
	return raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_wp_undo'").get().sql;
}
function sequenceNames(raw) {
	try {
		return raw.prepare('SELECT name FROM sqlite_sequence').all().map((r) => r.name);
	} catch {
		return [];
	}
}
function triggerCount(raw) {
	return raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_wp\\_undo\\_%' ESCAPE '\\'").get().n;
}
function triggerSql(raw) {
	return raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_wp\\_undo\\_%' ESCAPE '\\' ORDER BY name").all().map((r) => r.sql);
}

test('an open frame on the old AUTOINCREMENT table is undone, then the table is rebuilt (#577)', () => {
	const { db, storage, raw } = site();
	oldUndo(raw);
	raw.exec("INSERT INTO t (v) VALUES ('A')");
	const id = raw.prepare("SELECT id FROM t WHERE v = 'A'").get().id;
	raw.prepare('INSERT INTO _wp_undo (sql) VALUES (?)').run(`DELETE FROM "t" WHERE rowid = ${id}`);
	raw.exec('UPDATE _wp_undo_state SET active = 1 WHERE id = 1');
	const rec = isolate().u.recover(db, storage);
	assert.equal(rec.undone, 1);
	assert.deepEqual(ids(db), ['seed'], 'the open frame was undone before the rebuild');
	assert.doesNotMatch(undoDdl(raw), /AUTOINCREMENT/i);
	assert.ok(!sequenceNames(raw).includes('_wp_undo') && !sequenceNames(raw).includes('_wp_undo_old'), 'sqlite_sequence no longer tracks the undo log');
	const b = isolate();
	b.u.arm(db, 'after');
	run(b.u, db, "UPDATE t SET v = 'Z' WHERE v = 'seed'");
	isolate().u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed'], 'triggers on the rebuilt table still undo newest first');
});

test('a non-empty old log is left alone; the rebuild runs once it is empty, and the triggers stay (#577)', () => {
	const { db, storage, raw } = site();
	oldUndo(raw);
	raw.prepare('INSERT INTO _wp_undo (sql) VALUES (?)').run('UPDATE "t" SET "v" = "v" WHERE 0');
	const a = isolate();
	a.u.recover(db, storage);
	assert.match(undoDdl(raw), /AUTOINCREMENT/i, 'a non-empty log is not rebuilt');
	assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM _wp_undo').get().n, 1);
	a.u.arm(db, 'keep');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	assert.equal(triggerCount(raw), 3, 'triggers were installed against the old table');
	a.u.end(db);
	assert.deepEqual(ids(db), ['seed', 'A']);
	assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM _wp_undo').get().n, 0, 'a kept frame clears the log');
	const bodies = triggerSql(raw);
	assert.equal(bodies.length, 3);
	const b = isolate();
	b.u.recover(db, storage);
	assert.doesNotMatch(undoDdl(raw), /AUTOINCREMENT/i);
	assert.deepEqual(triggerSql(raw), bodies, 'the rebuilt table keeps the same trigger bodies; they name _wp_undo');
	assert.ok(!sequenceNames(raw).includes('_wp_undo') && !sequenceNames(raw).includes('_wp_undo_old'));
	b.u.arm(db, 'later');
	run(b.u, db, "UPDATE t SET v = 'Z' WHERE v = 'seed'");
	run(b.u, db, "UPDATE t SET v = 'Y' WHERE v = 'Z'");
	isolate().u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed', 'A']);
});

// The swap is several statements. A throw anywhere between the trigger drop and the recreate must
// leave the OLD table and its triggers, and the next isolate's recover() must migrate cleanly.
// The stub throws on the rename, which is the first statement after the drops.
test('a throw during the undo swap leaves the old table and its triggers; the next recover migrates (#577)', () => {
	const { db, storage, raw } = site();
	oldUndo(raw);
	raw.prepare('INSERT INTO _wp_undo (sql) VALUES (?)').run('UPDATE "t" SET "v" = \'seed\' WHERE 0');
	const a = isolate();
	a.u.recover(db, storage);
	a.u.arm(db, 'prime');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	assert.equal(triggerCount(raw), 3, 'triggers installed against the old table');
	a.u.end(db);
	assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM _wp_undo').get().n, 0);
	assert.match(undoDdl(raw), /AUTOINCREMENT/i);
	const beforeDdl = undoDdl(raw);
	const beforeTriggers = triggerSql(raw);
	const beforeSeq = sequenceNames(raw);
	const realExec = db.exec;
	let dropped = false;
	db.exec = (sql, ...params) => {
		const s = String(sql);
		if (/^\s*DROP TRIGGER\b/i.test(s)) dropped = true;
		if (dropped && /^\s*ALTER TABLE _wp_undo RENAME\b/i.test(s)) throw new Error('swap-cut');
		return realExec(sql, ...params);
	};
	assert.throws(() => isolate().u.recover(db, storage), /swap-cut/);
	db.exec = realExec;
	assert.equal(undoDdl(raw), beforeDdl, 'the old table is still _wp_undo');
	assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_wp_undo_old'").get().n, 0, 'the rename did not stay');
	assert.deepEqual(triggerSql(raw), beforeTriggers, 'the old triggers are intact');
	assert.deepEqual(sequenceNames(raw), beforeSeq, 'sqlite_sequence was not rewritten');
	const b = isolate();
	b.u.recover(db, storage);
	assert.doesNotMatch(undoDdl(raw), /AUTOINCREMENT/i, 'the next recover migrates');
	assert.deepEqual(triggerSql(raw), beforeTriggers, 'the same trigger bodies come back');
	assert.ok(!sequenceNames(raw).includes('_wp_undo') && !sequenceNames(raw).includes('_wp_undo_old'));
	b.u.arm(db, 'after');
	run(b.u, db, "UPDATE t SET v = 'Z' WHERE v = 'seed'");
	isolate().u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed', 'A'], 'a frame on the migrated table still rolls back');
});

// #684 (P0, measure only): a 201 create was absent after a CONCURRENT request's recovery. Recovery now
// names what it undid: per undone row the table, the op it replays, the rowid, and the request id the row
// was WRITTEN under. Shapes and ids only, never row data. cross counts rows of another request than the
// rolled-back frame's: a cross-request undo shows as cross > 0.
const rowsLine = (logs) => logs.find((o) => o.m === 'frame-recover-rows');
test('#684: recovery logs the table, op, rowid and writer request of each undone row, never values', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'rA');
	run(a.u, db, "INSERT INTO t (v) VALUES ('secretA')");
	run(a.u, db, "UPDATE t SET v = 'secretS' WHERE v = 'seed'");
	// A second request arms while the frame is still open (the interleave #684 suspects).
	a.u.arm(db, 'rB');
	run(a.u, db, "INSERT INTO t (v) VALUES ('secretB')");
	run(a.u, db, "DELETE FROM t WHERE v = 'secretA'");
	const b = isolate();
	b.u.recover(db, storage);
	const l = rowsLine(b.logs);
	assert.ok(l, 'a frame-recover-rows line');
	assert.deepEqual(l.rows, [
		{ t: 't', op: 'insert', rowid: 2, req: 'rB' },
		{ t: 't', op: 'delete', rowid: 3, req: 'rB' },
		{ t: 't', op: 'update', rowid: 1, req: 'rA' },
		{ t: 't', op: 'delete', rowid: 2, req: 'rA' },
	], 'newest first, as replayed');
	assert.equal(l.undone, 4);
	assert.equal(l.frameReq, 'rA', 'the frame row recovery labels rolled-back: the request that OPENED it');
	assert.deepEqual(l.byReq, { rA: 2, rB: 2 });
	assert.equal(l.cross, 2, 'rows written under another request than the rolled-back frame');
	assert.ok(!/secret|seed/.test(JSON.stringify(b.logs)), 'no row value in any log line');
});
test('#684: a recovery of one request reports cross 0; a recovery with nothing active logs no rows line', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r1');
	run(a.u, db, "INSERT INTO t (v) VALUES ('x')");
	const b = isolate();
	b.u.recover(db, storage);
	const l = rowsLine(b.logs);
	assert.deepEqual(l.rows, [{ t: 't', op: 'delete', rowid: 2, req: 'r1' }]);
	assert.equal(l.cross, 0);
	const c = isolate();
	c.u.recover(db, storage);
	assert.equal(rowsLine(c.logs), undefined);
});
test('#684: an undo log from a build before the req column is recovered, its rows reported with req null', () => {
	const { db, storage, raw } = site();
	raw.exec('CREATE TABLE _wp_undo (seq INTEGER PRIMARY KEY, sql TEXT NOT NULL)');
	raw.exec('CREATE TABLE _wp_undo_state (id INTEGER PRIMARY KEY CHECK (id = 1), active INTEGER NOT NULL)');
	raw.exec('INSERT INTO _wp_undo_state (id, active) VALUES (1, 1)');
	raw.exec("INSERT INTO t (v) VALUES ('old')");
	raw.exec(`INSERT INTO _wp_undo (sql) VALUES ('DELETE FROM "t" WHERE rowid = 2')`);
	const b = isolate();
	b.u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed']);
	assert.deepEqual(rowsLine(b.logs).rows, [{ t: 't', op: 'delete', rowid: 2, req: null }]);
	// The next frame on this database writes the req column (added on first use).
	b.u.arm(db, 'r9');
	run(b.u, db, "INSERT INTO t (v) VALUES ('n')");
	const c = isolate();
	c.u.recover(db, storage);
	assert.deepEqual(rowsLine(c.logs).rows, [{ t: 't', op: 'delete', rowid: 2, req: 'r9' }]);
});
test('#684: the writer tag costs a state write only when the writing request changes', () => {
	const { db } = site();
	const a = isolate();
	a.u.arm(db, 'rA');
	run(a.u, db, "INSERT INTO t (v) VALUES ('1')");
	const own1 = a.u.counts().own;
	run(a.u, db, "INSERT INTO t (v) VALUES ('2')");
	assert.equal(a.u.counts().own, own1, 'same request: no extra write');
	a.u.arm(db, 'rB');
	run(a.u, db, "INSERT INTO t (v) VALUES ('3')");
	assert.equal(a.u.counts().own, own1 + 1, 'a new writer: one state update');
});

test('#794 rollbackFrame: a reset-class failure in a SURVIVING isolate rolls the frame back now, as recover() would', () => {
	const { db, storage } = site();
	const ran = [];
	const a = isolate();
	a.u.arm(db, 'r794');
	run(a.u, db, "UPDATE t SET v = 'the-default' WHERE v = 'seed'");
	run(a.u, db, "INSERT INTO t (v) VALUES ('B')");
	a.u.defer(() => ran.push('l2'));
	const rb = a.u.rollbackFrame(db, storage);
	assert.deepEqual({ undone: rb.undone, points: rb.points, req: rb.req }, { undone: 2, points: 0, req: 'r794' });
	assert.deepEqual(ids(db), ['seed'], 'the overwrite and the insert are both undone, in the same isolate');
	assert.equal(a.u.frameOpen(), false);
	a.u.end(db); // the request ends as usual
	assert.deepEqual({ ...a.u.status(db, 'r794'), t: 0 }, { req: 'r794', state: 'rolled-back', points: 0, kinds: '', undone: 2, t: 0 }, 'end() does not mark it kept again; /_frame proves it');
	assert.deepEqual(ran, [], 'its deferred work (L2 sets) never runs');
	const b = isolate();
	b.u.recover(db, storage);
	assert.deepEqual(ids(db), ['seed'], 'a later recovery has nothing left to undo');
	assert.equal(a.u.rollbackFrame(db, storage), null, 'no frame open: nothing to roll back');
});

test('#794 a rollbackFrame that THROWS (its undo meets the same ceiling) is never kept: the frame stays for recover()', () => {
	const { db, storage } = site();
	const ran = [];
	const a = isolate();
	a.u.arm(db, 'r794x');
	run(a.u, db, "UPDATE t SET v = 'the-default' WHERE v = 'seed'");
	a.u.defer(() => ran.push('l2'));
	// The undo runs, then the storage fails inside the same transaction: SQLite takes the whole of it back.
	const ceiling = { transactionSync: (fn) => storage.transactionSync(() => { fn(); throw new Error("Durable Object's isolate exceeded its memory limit and was reset."); }) };
	assert.throws(() => a.u.rollbackFrame(db, ceiling), /memory limit/);
	assert.deepEqual(ids(db), ['the-default'], 'the failed undo changed nothing');
	a.u.end(db, storage); // the request ends as usual (txnEnd)
	assert.equal(a.u.status(db, 'r794x').state, 'open', 'end() did NOT mark it kept');
	assert.equal(db.exec('SELECT active FROM _wp_undo_state WHERE id = 1').one().active, 1, 'stored active stays 1, so a recovery sees it');
	assert.ok(db.exec('SELECT COUNT(*) AS c FROM _wp_undo').one().c > 0, 'its undo rows are still there');
	assert.deepEqual(ran, [], 'its deferred work (L2 sets) never runs');
	// The next request in THIS isolate recovers first (txnRecover runs on every request): it is rolled back now.
	const r = a.u.recover(db, storage);
	assert.equal(r && r.req, 'r794x');
	assert.deepEqual(ids(db), ['seed'], 'the derived write is gone');
	assert.equal(a.u.status(db, 'r794x').state, 'rolled-back');
	assert.equal(a.u.recover(db, storage), null, 'and recover() is once per isolate again');
});

test('#794 a recover() whose undo throws is tried again by the next request, never marked done', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r794y');
	run(a.u, db, "UPDATE t SET v = 'the-default' WHERE v = 'seed'"); // the isolate dies here: the frame stays open
	const b = isolate();
	const ceiling = { transactionSync: (fn) => storage.transactionSync(() => { fn(); throw new Error('SQLITE_FULL: database or disk is full'); }) };
	assert.throws(() => b.u.recover(db, ceiling), /SQLITE_FULL/);
	assert.equal(db.exec('SELECT active FROM _wp_undo_state WHERE id = 1').one().active, 1, 'still visible to a recovery');
	assert.equal(b.u.recover(db, storage).req, 'r794y', 'the next request retries it');
	assert.deepEqual(ids(db), ['seed']);
});

// #809: a stranded frame (a failed rollback, then a failed recovery) must not have later writes land under it.
const ceiling809 = (storage) => ({ transactionSync: (fn) => storage.transactionSync(() => { fn(); throw new Error("Durable Object's isolate exceeded its memory limit and was reset."); }) });
function strand809() {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r-bad');
	run(a.u, db, "UPDATE t SET v = 'derived' WHERE v = 'seed'");
	assert.throws(() => a.u.rollbackFrame(db, ceiling809(storage)));
	a.u.end(db, storage);
	assert.throws(() => a.u.recover(db, ceiling809(storage))); // the next request: the recovery fails as well
	const undoRows = db.exec('SELECT COUNT(*) AS c FROM _wp_undo').one().c;
	return { db, storage, a, undoRows };
}
const intact809 = (db, undoRows) => {
	assert.deepEqual(db.exec('SELECT active, req FROM _wp_undo_state WHERE id = 1').one(), { active: 1, req: 'r-bad' }, 'the stranded frame is still stored open');
	assert.equal(db.exec('SELECT COUNT(*) AS c FROM _wp_undo').one().c, undoRows, 'its undo rows untouched');
};
const recovered809 = (a, db, storage) => {
	assert.equal(a.u.recover(db, storage).req, 'r-bad', 'a recovery that succeeds rolls the stranded frame back');
	assert.deepEqual(ids(db), ['seed'], 'the derived write is gone');
	assert.equal(a.u.stranded(), false, 'and writes may proceed');
};

test('#809 P2: an UNARMED writer (the cron alarm) under a stranded frame is refused, never logged under it', () => {
	const { db, storage, a, undoRows } = strand809();
	assert.throws(() => run(a.u, db, "INSERT INTO t (v) VALUES ('cron-write')"), /stranded/);
	assert.equal(a.u.stranded(), true, 'the gate index.js reads (the 503, the cron deferral)');
	assert.deepEqual(ids(db), ['derived'], 'the write did not land');
	intact809(db, undoRows);
	recovered809(a, db, storage);
	run(a.u, db, "INSERT INTO t (v) VALUES ('cron-write')");
	assert.equal(a.u.recover(db, storage), null);
	assert.deepEqual(ids(db), ['seed', 'cron-write'], 'after the recovery the write lands, and no later recovery erases it');
});

test('#809 P1: a FRAMED request under a stranded frame is refused, so its end() cannot wipe the stranded undo', () => {
	const { db, storage, a, undoRows } = strand809();
	a.u.arm(db, 'r-shopper');
	assert.throws(() => run(a.u, db, "INSERT INTO t (v) VALUES ('order')"), /stranded/);
	a.u.end(db, storage);
	assert.deepEqual(ids(db), ['derived']);
	intact809(db, undoRows);
	assert.notEqual(a.u.status(db, 'r-shopper') && a.u.status(db, 'r-shopper').state, 'kept', 'no frame of it was kept');
	recovered809(a, db, storage);
});

test('#809 P3: a commit point or a PHP transaction under a stranded frame cannot wipe the stranded undo', () => {
	const { db, storage, a, undoRows } = strand809();
	a.u.arm(db, 'r-shopper');
	a.u.commitPoint(db, 'http');
	assert.equal(a.u.txnOp(db, storage, { op: 'begin' }).ok, false, 'BEGIN is refused');
	assert.equal(a.u.txnOp(db, storage, { op: 'commit' }).ok, true, 'a COMMIT with nothing open does nothing');
	assert.throws(() => run(a.u, db, 'CREATE TABLE n809 (id INTEGER PRIMARY KEY)'), /stranded/, 'DDL (an implicit commit point) is refused');
	a.u.end(db, storage);
	intact809(db, undoRows);
	recovered809(a, db, storage);
});

test('#809 a stranded frame refuses writes only: reads still run (the Worker gate answers the request first)', () => {
	const { db, a } = strand809();
	assert.deepEqual(run(a.u, db, 'SELECT v FROM t').toArray(), [{ v: 'derived' }]);
});

test('#809 the undo-failure seam strands a frame through rollbackFrame and recover() only, never a PHP ROLLBACK', () => {
	const { db, storage } = site();
	let on = true;
	const logs = [];
	const u = createUndoLog({ stats: { txnOps: 0, undoRows: 0 }, log: (o) => logs.push(o), frames: true, undoFault: () => (on ? 'injected reset' : null) });
	u.arm(db, 'r-seam');
	assert.equal(u.txnOp(db, storage, { op: 'begin' }).ok, true);
	run(u, db, "INSERT INTO t (v) VALUES ('in-txn')");
	assert.equal(u.txnOp(db, storage, { op: 'rollback' }).ok, true, 'a PHP ROLLBACK is never faulted');
	assert.deepEqual(ids(db), ['seed']);
	run(u, db, "UPDATE t SET v = 'derived' WHERE v = 'seed'");
	assert.throws(() => u.rollbackFrame(db, storage), /injected reset/);
	assert.deepEqual(ids(db), ['derived'], 'the faulted undo applied nothing');
	u.end(db, storage);
	assert.throws(() => u.recover(db, storage), /injected reset/);
	assert.equal(u.stranded(), true);
	on = false;
	assert.equal(u.recover(db, storage).req, 'r-seam');
	assert.deepEqual(ids(db), ['seed']);
	assert.equal(u.stranded(), false);
});

test('#794 rollbackFrame stops at a commit point: what was kept at the point stays kept, and it is not proof of "nothing saved"', () => {
	const { db, storage } = site();
	const a = isolate();
	a.u.arm(db, 'r794p');
	run(a.u, db, "INSERT INTO t (v) VALUES ('A')");
	run(a.u, db, 'CREATE TABLE n2 (id INTEGER PRIMARY KEY, w TEXT)');
	run(a.u, db, "INSERT INTO n2 (w) VALUES ('N')");
	const rb = a.u.rollbackFrame(db, storage);
	assert.equal(rb.points, 1);
	assert.deepEqual(ids(db), ['seed', 'A'], 'before the DDL: kept');
	assert.equal(db.exec('SELECT COUNT(*) AS c FROM n2').one().c, 0, 'after it: undone');
	assert.equal(a.u.status(db, 'r794p').state, 'rolled-back');
	assert.equal(a.u.status(db, 'r794p').points, 1, 'a point passed, so frameProvesRollback is false and the answer stays "may have been saved"');
});

const ACT = 'UPDATE `wp_options` SET `option_value` = ? WHERE `option_name` = ?';
const PLUGIN = 'active:gutenberg-test-plugins/default-post-content.php';

function optionsDb() {
	const s = site();
	s.db.exec('CREATE TABLE wp_options (option_id INTEGER PRIMARY KEY, option_name TEXT UNIQUE, option_value TEXT, autoload TEXT)');
	s.db.exec("INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('active_plugins', 'inactive', 'yes')");
	s.db.exec("INSERT INTO wp_options (option_name, option_value, autoload) VALUES ('blogname', 'Demo', 'yes')");
	return s;
}
function opt(db, name) {
	const rows = [...db.exec('SELECT option_value FROM wp_options WHERE option_name = ?', name).raw()];
	return rows.length ? rows[0][0] : null;
}

test('#938 pluginStatusWrite reads option_name, not a value that equals the same string', () => {
	const upd = 'UPDATE `wp_options` SET `option_value` = ? WHERE `option_name` = ?';
	assert.deepEqual(pluginStatusWrite(upd, [PLUGIN, 'active_plugins']), { table: 'wp_options', key: 'active_plugins' });
	assert.equal(pluginStatusWrite(upd, ['active_plugins', 'blogname']), null, 'the value is not the option name');
	assert.deepEqual(
		pluginStatusWrite('UPDATE `wp_options` SET `option_value` = ?, `autoload` = ? WHERE `option_name` = ?', [PLUGIN, 'yes', 'active_sitewide_plugins']),
		{ table: 'wp_options', key: 'active_sitewide_plugins' },
	);
	assert.deepEqual(
		pluginStatusWrite("UPDATE wp_options SET option_value = 'x' WHERE option_name = 'active_plugins'", []),
		{ table: 'wp_options', key: 'active_plugins' },
	);
	assert.deepEqual(
		pluginStatusWrite('INSERT INTO `wp_options` (`option_name`, `option_value`, `autoload`) VALUES (?, ?, ?)', ['active_plugins', PLUGIN, 'yes']),
		{ table: 'wp_options', key: 'active_plugins' },
	);
	assert.equal(pluginStatusWrite('UPDATE wp_posts SET post_title = ? WHERE ID = ?', [PLUGIN, '1']), null);
	assert.equal(pluginStatusWrite('SELECT option_value FROM wp_options WHERE option_name = ?', ['active_plugins']), null);
});

test('#938 activate then write-loss: the plugin is inactive, and a commit point still keeps every other row', () => {
	const { db, storage } = optionsDb();
	const a = isolate();
	a.u.arm(db, 'r938');
	run(a.u, db, ACT, PLUGIN, 'active_plugins');
	run(a.u, db, ACT, 'Dirty', 'blogname');
	run(a.u, db, ACT, 'active_plugins', 'blogname'); // a value equal to the key must not be treated as plugin status
	a.u.commitPoint(db, 'http');
	run(a.u, db, "INSERT INTO t (v) VALUES ('after')");
	const rb = a.u.rollbackFrame(db, storage);
	assert.equal(rb.points, 1, 'the commit point still counts');
	assert.equal(opt(db, 'active_plugins'), 'inactive', 'the activate did not stick');
	assert.equal(opt(db, 'blogname'), 'active_plugins', 'the other option stayed kept');
	assert.deepEqual(ids(db), ['seed'], 'the write after the commit point is undone');
	assert.equal(a.u.status(db, 'r938').state, 'rolled-back');
	assert.equal(a.u.status(db, 'r938').points, 1, 'not proof that nothing was saved');
	a.u.end(db, storage);
	assert.equal(opt(db, 'active_plugins'), 'inactive', 'end() does not put the plugin back');
});

test('#938 a killed activate is inactive after recover, including after a commit point', () => {
	const { db, storage } = optionsDb();
	const a = isolate();
	a.u.arm(db, 'r938k');
	run(a.u, db, ACT, PLUGIN, 'active_plugins');
	run(a.u, db, ACT, 'Dirty', 'blogname');
	a.u.commitPoint(db, 'http');
	// The isolate dies. end() never runs. The next isolate recovers first.
	const b = isolate();
	b.u.recover(db, storage);
	assert.equal(opt(db, 'active_plugins'), 'inactive');
	assert.equal(opt(db, 'blogname'), 'Dirty');
});

test('#938 a finished activate stays active, and a later recovery does not undo it', () => {
	const { db, storage } = optionsDb();
	const a = isolate();
	a.u.arm(db, 'r938ok');
	run(a.u, db, ACT, PLUGIN, 'active_plugins');
	a.u.commitPoint(db, 'http');
	a.u.end(db, storage);
	assert.equal(opt(db, 'active_plugins'), PLUGIN);
	assert.equal(a.u.status(db, 'r938ok').state, 'kept');
	const b = isolate();
	b.u.recover(db, storage);
	assert.equal(opt(db, 'active_plugins'), PLUGIN, 'recovery must not deactivate a finished request');
});

test('#938 an inserted active_plugins row does not survive write-loss', () => {
	const { db, storage } = site();
	db.exec('CREATE TABLE wp_options (option_id INTEGER PRIMARY KEY, option_name TEXT UNIQUE, option_value TEXT, autoload TEXT)');
	const a = isolate();
	a.u.arm(db, 'r938i');
	run(a.u, db, 'INSERT INTO `wp_options` (`option_name`, `option_value`, `autoload`) VALUES (?, ?, ?)', 'active_plugins', PLUGIN, 'yes');
	a.u.commitPoint(db, 'http');
	a.u.rollbackFrame(db, storage);
	assert.equal(opt(db, 'active_plugins'), null, 'the insert is removed');
});

test('#938 index.js passes statement params so a plugin status write can be held', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /undoLog\.statement\(db, sqlStorage, m\.sql, run, params\)/);
});
