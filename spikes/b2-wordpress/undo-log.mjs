// The undo log of the PHP object's SQLite (#60) and the REQUEST FRAME on it (#352).
//
// #60, moved here from index.js unchanged in behavior (docs/approach-b.md 8l): the object's SQLite
// refuses BEGIN and SAVEPOINT, so while a transaction is open, per-table triggers write the inverse
// SQL of each row change to _wp_undo (SQLite's "Automatic Undo/Redo"), and a ROLLBACK replays it,
// newest first. _wp_undo_state.active is STORED, so an isolate that died with it set is rolled back
// by the next one (recover()). PHP's own BEGIN, COMMIT, ROLLBACK and savepoints reach txnOp() through
// php/real-transactions.php.
//
// #352, the request frame (frames = REQUEST_FRAMES=on): a request is armed (arm()) before PHP runs.
// The frame OPENS LAZILY, at the request's first statement that CHANGES a row (statement(), which
// index.js sqlStatement runs every PHP statement through): the open, the statement and its first undo
// row run in ONE storage transaction, and a statement that may write but changed no row (an UPDATE or
// DELETE matching nothing, an INSERT OR IGNORE that conflicts) takes the open back, so a request that
// changes nothing commits nothing durable for the frame (counts.noop).
// It closes KEPT when the request ends (end()), a PHP fatal included: the frame hides OUR platform's
// failure (an isolate reset), not WordPress's (autocommit semantics). It closes ROLLED BACK only by
// recover() in the next isolate. Inside a frame:
// - a PHP BEGIN is a savepoint of the frame, its COMMIT a release, its ROLLBACK undoes only its part;
// - a COMMIT POINT (DDL, an outbound non-GET HTTP call, an R2 delete or copy) closes the frame KEPT
//   just before the effect: a rollback never erases a row an outside party may already know about. The
//   next write opens a new frame;
// - defer(fn) holds work that must not outlive a rollback (the KV L2 cache sets) until the frame is kept.
// _wp_frame keeps the outcome per request id (a short history) for the Worker's /_frame probe, so a
// client is only told "nothing was saved" when it is proven.
//
// #577: _wp_undo.seq is INTEGER PRIMARY KEY, not AUTOINCREMENT. AUTOINCREMENT updates sqlite_sequence
// on every insert, and the object's rowsWritten bills that extra row (one per undo row, about 3 per
// framed save). Replay stays ORDER BY seq DESC. A reused seq cannot pass a live savepoint: undoTo
// deletes only seq > s, and every savepoint still live has recorded a seq at or below the log's top.
// A site that already has the AUTOINCREMENT table is rebuilt on first use, when the log is empty.
// recover() (the constructor, inside blockConcurrencyWhile) undoes an open frame first, then rebuilds.
// undoSetup rebuilds too, if it finds the old table and the log is already empty. A non-empty log stays
// on the old table until the next empty point, and still replays. The rebuild (trigger drop, rename,
// create, copy, drop, the sqlite_sequence delete, and the trigger recreate) is one
// storage.transactionSync, so it commits whole or not at all. The trigger bodies insert into
// _wp_undo by name, so they do not change.

const UNDO_TABLES = new Set(['_wp_undo', '_wp_undo_state', '_wp_frame']);
const FRAME_HISTORY = 32;

/**
 * A statement that may change a row the undo triggers cover. Conservative: everything may, except a plain
 * SELECT or EXPLAIN and the statements that change no covered row: any PRAGMA (a setter too), VACUUM,
 * ANALYZE and REINDEX. Those must also never run inside the frame's opening transaction (SQLite ignores
 * PRAGMA foreign_keys in one, VACUUM refuses one). CI at 105776b: a PRAGMA opened 10 of 10 public frames.
 */
export function mayWrite(sql) {
	const s = String(sql || '');
	if (/\bRETURNING\b/i.test(s)) return true;
	if (/^\s*(SELECT|EXPLAIN|PRAGMA|VACUUM|ANALYZE|REINDEX)\b/i.test(s)) return false;
	return true;
}
/** The verb and the first table of a statement, for a log or x-perf: never its values. */
export function shapeOf(sql) {
	const s = String(sql || '').replace(/\s+/g, ' ').trim();
	const verb = (s.match(/^(\w+)/) || [, '?'])[1].toUpperCase();
	const t = s.match(/\b(?:INTO|FROM|UPDATE|TABLE|PRAGMA)\s+[`"]?([A-Za-z0-9_]+)/i);
	const or = s.match(/^\w+\s+OR\s+(\w+)/i);
	const onc = /\bON\s+CONFLICT\b/i.test(s) ? ' ON CONFLICT' : '';
	return verb + (or ? ' OR ' + or[1].toUpperCase() : '') + (t ? ' ' + t[1] : '') + onc;
}
/** DDL: MySQL's implicit commit, a commit point of the frame. */
export function isDdl(sql) {
	return /^\s*(CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i.test(String(sql || ''));
}

function sqlId(name) {
	return '"' + String(name).replace(/"/g, '""') + '"';
}
function sqlLit(text) {
	return "'" + String(text).replace(/'/g, "''") + "'";
}
function shortHash(text) {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
	return h.toString(16).padStart(8, '0');
}
// A signature of sqlite_master (entries and the length of their SQL): any DDL changes it. PRAGMA
// schema_version would be the direct way, but the object's SQLite refuses it (SQLITE_AUTH).
function schemaSig(db) {
	const r = db.exec('SELECT COUNT(*) AS n, TOTAL(LENGTH(sql)) AS l FROM sqlite_master').one();
	return r.n + ':' + r.l;
}
// #684 (measure only): each undo row records the request it was WRITTEN under (_wp_undo.req, copied by the
// triggers from _wp_undo_state.req, which holds the request now writing), so a recovery can name a row
// another request wrote. A database from a build before this gets the columns on first use.
function hasCol(db, table, col) {
	return [...db.exec(`PRAGMA table_info(${table})`).raw()].some((r) => r[1] === col);
}
function ensureReqCols(db) {
	if (!hasCol(db, '_wp_undo', 'req')) db.exec('ALTER TABLE _wp_undo ADD COLUMN req TEXT');
	if (!hasCol(db, '_wp_undo_state', 'req')) db.exec('ALTER TABLE _wp_undo_state ADD COLUMN req TEXT');
}
// The shape of one replay statement (the trigger bodies below write it): its verb, table and rowid. Never values.
export function undoShape(stmt) {
	const s = String(stmt || '');
	const m = s.match(/^(DELETE FROM|UPDATE|INSERT INTO) "((?:[^"]|"")*)"/);
	if (!m) return { t: null, op: '?', rowid: null };
	const op = m[1].split(' ')[0].toLowerCase();
	const r = op === 'insert' ? s.match(/\) VALUES \((-?\d+),/) : s.match(/WHERE rowid = (-?\d+)$/);
	return { t: m[2].replace(/""/g, '"'), op, rowid: r ? Number(r[1]) : null };
}
const RECOVER_ROWS_MAX = 64;

// frames: a boolean, or a function asked each time it matters (index.js: the undo log may be made by the
// PhpRuntime constructor's recovery before any fetch has set ENV, so a value fixed at creation was wrong).
// #809: the refusal's message. It names a storage failure, so #795 classes it a PLATFORM failure (a retryable answer).
export const STRANDED_ERROR = 'storage reset pending: a request frame is stranded until its recovery succeeds (#809)';

export function createUndoLog({ stats, objectCacheDrop = () => {}, log = () => {}, frames = false } = {}) {
	const framesOn = () => !!(typeof frames === 'function' ? frames() : frames);
	let undoSchemaSig = null;
	let setupDone = false;
	let txnFrames = null; // PHP's transaction and its savepoints: [{ name, seq }]
	const txnTouched = new Set();
	let armedReq = null; // the request id a frame may open for
	// #809: a frame is STRANDED when its rollback failed and no recovery has succeeded since. It is still stored open
	// (active 1, its undo rows), and no write may land under it: an unarmed write would be logged into it and erased at
	// the recovery, and a later frame kept, a commit point or a PHP transaction would wipe its undo and keep the
	// write it exists to undo. Writes are refused until recover() succeeds; index.js answers a retryable 503 first.
	let stranded = false;
	let frameOpen = false;
	let points = 0;
	let kinds = [];
	let deferred = [];
	let recovered = false;
	let stateReq = null; // the request _wp_undo_state.req names now (#684); null after a frame or txn closes
	let lastUndone = null; // the shapes of the rows undoTo replayed, when asked (recover)
	const counts = { opened: 0, kept: 0, points: 0, miss: 0, noop: 0, own: 0 };
	// The rows the undo log and the frame write THEMSELVES (state, frame rows, the log cleared or replayed),
	// which x-db-rows never sees: it counts PHP's statements, their undo-trigger rows included.
	const own = (cur) => { counts.own += (cur && cur.rowsWritten) || 0; return cur; };
	let openedBy = null; // the shape (verb and table, never values) of the statement that opened the last frame

	// One-time rebuild of a _wp_undo left by a build that used AUTOINCREMENT (#577). Only when the log
	// is empty and no frame is active: a non-empty log is mid-frame, or leftover rows this call must
	// not rewrite. The swap, triggers included, is one storage transaction: a throw anywhere in it
	// leaves the old table and its triggers. Move the old table aside, create the plain one under the
	// same name, copy, drop the old table, drop its sqlite_sequence row, then put the triggers back.
	function migrateUndo(db, storage) {
		let sql = '';
		try {
			sql = db.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_wp_undo'").one().sql || '';
		} catch {
			return false;
		}
		if (!/autoincrement/i.test(sql)) return false;
		if (db.exec('SELECT COUNT(*) AS n FROM _wp_undo').one().n !== 0) return false;
		try {
			if (db.exec('SELECT active FROM _wp_undo_state WHERE id = 1').one().active) return false;
		} catch {
			// no state row yet: nothing is mid-frame
		}
		// Drop the undo triggers first. Renaming or dropping _wp_undo while they still name it makes
		// SQLite recompile them against a missing table ("no such table: main._wp_undo"). They are
		// recreated below, same bodies: the body hashes to the same name, and it inserts into _wp_undo
		// by name, so the new table needs no trigger edit. The drop and the recreate are in the same
		// transaction, so a failure cannot leave the table with no triggers.
		const swap = () => {
			const triggers = [...db.exec("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_wp\\_undo\\_%' ESCAPE '\\'").raw()].map((r) => r[0]);
			for (const name of triggers) db.exec(`DROP TRIGGER IF EXISTS ${sqlId(name)}`);
			db.exec('ALTER TABLE _wp_undo RENAME TO _wp_undo_old');
			db.exec('CREATE TABLE _wp_undo (seq INTEGER PRIMARY KEY, sql TEXT NOT NULL, req TEXT)');
			db.exec('INSERT INTO _wp_undo (seq, sql) SELECT seq, sql FROM _wp_undo_old');
			db.exec('DROP TABLE _wp_undo_old');
			try {
				db.exec("DELETE FROM sqlite_sequence WHERE name = '_wp_undo' OR name = '_wp_undo_old'");
			} catch {
				// the drop already removed the row, or this database has no sequence table
			}
			undoSchemaSig = null; // sqlite_master changed; put the same triggers back on the new table
			undoTriggers(db);
		};
		try {
			if (storage && typeof storage.transactionSync === 'function') storage.transactionSync(swap);
			else swap();
		} catch (e) {
			undoSchemaSig = null; // the swap did not commit; drop any sig taken inside it
			throw e;
		}
		return true;
	}
	function undoSetup(db, storage) {
		if (setupDone) return;
		migrateUndo(db, storage);
		db.exec('CREATE TABLE IF NOT EXISTS _wp_undo (seq INTEGER PRIMARY KEY, sql TEXT NOT NULL, req TEXT)');
		db.exec('CREATE TABLE IF NOT EXISTS _wp_undo_state (id INTEGER PRIMARY KEY CHECK (id = 1), active INTEGER NOT NULL, req TEXT)');
		ensureReqCols(db);
		own(db.exec('INSERT OR IGNORE INTO _wp_undo_state (id, active) VALUES (1, 0)'));
		if (framesOn()) db.exec('CREATE TABLE IF NOT EXISTS _wp_frame (req TEXT PRIMARY KEY, state TEXT NOT NULL, points INTEGER NOT NULL, kinds TEXT NOT NULL, undone INTEGER NOT NULL, t INTEGER NOT NULL)');
		setupDone = true;
	}
	function undoTriggers(db) {
		if (schemaSig(db) === undoSchemaSig) return;
		ensureReqCols(db);
		const tables = [...db.exec("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").raw()].filter(([name, sql]) => !UNDO_TABLES.has(name) && !/WITHOUT\s+ROWID/i.test(sql || ''));
		const existing = new Set([...db.exec("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '\\_wp\\_undo\\_%' ESCAPE '\\'").raw()].map((r) => r[0]));
		const want = new Set();
		const when = 'WHEN (SELECT active FROM _wp_undo_state WHERE id = 1) = 1';
		const writer = '(SELECT req FROM _wp_undo_state WHERE id = 1)';
		for (const [table] of tables) {
			const cols = [...db.exec(`PRAGMA table_info(${sqlId(table)})`).raw()].map((r) => r[1]);
			if (!cols.length) continue;
			// The name hashes the whole trigger body, so a changed body (a new release, a new column) gets a new
			// name: the old trigger is dropped below and the new one is created. Never keep a trigger by table name alone.
			const t = sqlId(table);
			const bodies = {
				i: `AFTER INSERT ON ${t} ${when} BEGIN INSERT INTO _wp_undo (sql, req) VALUES (${sqlLit(`DELETE FROM ${t} WHERE rowid = `)} || new.rowid, ${writer}); END`,
				u: `AFTER UPDATE ON ${t} ${when} BEGIN INSERT INTO _wp_undo (sql, req) VALUES (${sqlLit(`UPDATE ${t} SET rowid = `)} || old.rowid || ${cols.map((c) => `${sqlLit(`, ${sqlId(c)} = `)} || quote(old.${sqlId(c)})`).join(' || ')} || ${sqlLit(' WHERE rowid = ')} || new.rowid, ${writer}); END`,
				d: `AFTER DELETE ON ${t} ${when} BEGIN INSERT INTO _wp_undo (sql, req) VALUES (${sqlLit(`INSERT INTO ${t} (rowid, ${cols.map(sqlId).join(', ')}) VALUES (`)} || old.rowid || ${cols.map((c) => `${sqlLit(', ')} || quote(old.${sqlId(c)})`).join(' || ')} || ')', ${writer}); END`,
			};
			for (const [kind, body] of Object.entries(bodies)) {
				const name = `_wp_undo_${shortHash(table + '\u0000' + body)}_${kind}`;
				want.add(name);
				if (!existing.has(name)) db.exec(`CREATE TRIGGER ${name} ${body}`);
			}
		}
		for (const name of existing) if (!want.has(name)) db.exec(`DROP TRIGGER IF EXISTS ${sqlId(name)}`);
		undoSchemaSig = schemaSig(db);
	}
	const undoSeq = (db) => db.exec('SELECT COALESCE(MAX(seq), 0) AS s FROM _wp_undo').one().s;
	const setActive = (db, on) => own(db.exec('UPDATE _wp_undo_state SET active = ? WHERE id = 1', on ? 1 : 0));
	// Off at a frame's or a transaction's close, in the same one-row write: the writer goes too (#684).
	const setIdle = (db) => { stateReq = null; return own(db.exec('UPDATE _wp_undo_state SET active = 0, req = NULL WHERE id = 1')); };
	// The request now writing, before its statement (#684): one state write, only when the writer changes.
	function tagWriter(db) {
		if (!armedReq || !frameOpen || stateReq === armedReq) return;
		own(db.exec('UPDATE _wp_undo_state SET req = ? WHERE id = 1', armedReq));
		stateReq = armedReq;
	}
	// Undo every change after seq, newest first, in one storage transaction.
	function undoTo(db, storage, seq, detail = false) {
		const rows = [...db.exec(`SELECT sql${detail ? ', req' : ''} FROM _wp_undo WHERE seq > ? ORDER BY seq DESC`, seq).raw()];
		if (detail) lastUndone = rows.map(([stmt, req]) => ({ ...undoShape(stmt), req: req ?? null }));
		// #794 review: the stored active flag goes off INSIDE the transaction (the triggers must not log the undo
		// itself). An undo that fails takes it back with everything else, so a recovery still sees the open frame.
		const apply = () => {
			setActive(db, false);
			for (const [stmt] of rows) own(db.exec(stmt));
			own(db.exec('DELETE FROM _wp_undo WHERE seq > ?', seq));
		};
		if (storage && typeof storage.transactionSync === 'function') storage.transactionSync(apply);
		else apply();
		stats.undoRows += rows.length;
		for (const k of txnTouched) objectCacheDrop(k);
		txnTouched.clear();
		return rows.length;
	}
	// PHP's transaction ends; the frame, if open, goes on (active stays 1).
	function phpClose(db) {
		txnFrames = null;
		txnTouched.clear();
		if (!frameOpen) {
			setIdle(db);
			own(db.exec('DELETE FROM _wp_undo'));
		}
	}
	function frameRow(db, req, state) {
		own(db.exec('INSERT INTO _wp_frame (req, state, points, kinds, undone, t) VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT (req) DO UPDATE SET state = excluded.state, points = excluded.points, kinds = excluded.kinds, t = excluded.t', req, state, points, kinds.join(','), Date.now()));
	}
	function frameOpenNow(db, sql, storage) {
		openedBy = sql ? shapeOf(sql) : 'php-begin';
		undoSetup(db, storage);
		undoTriggers(db);
		own(db.exec('UPDATE _wp_undo_state SET active = 1, req = ? WHERE id = 1', armedReq));
		stateReq = armedReq;
		frameOpen = true;
		counts.opened++;
		frameRow(db, armedReq, 'open');
		own(db.exec('DELETE FROM _wp_frame WHERE req NOT IN (SELECT req FROM _wp_frame ORDER BY t DESC LIMIT ?)', FRAME_HISTORY));
	}
	// At recovery, no request of THIS isolate runs yet, so a frame row still 'open' belongs to a request a dead
	// isolate was running: one killed after a commit point with nothing active since (the lead's ruling,
	// pf352f point case). It gets 'ended-at-reset': a write only after a reset, never on the normal path.
	function relabelEnded(db) {
		try {
			return own(db.exec("UPDATE _wp_frame SET state = 'ended-at-reset' WHERE state = 'open'")).rowsWritten || 0;
		} catch {
			return 0; // frames were never on here
		}
	}
	// Close the frame KEPT: its rows stay, the log goes, deferred work runs.
	function frameKeep(db, state) {
		if (txnFrames) txnFrames = txnFrames.map((f) => ({ ...f, seq: 0 })); // a PHP txn spanning a commit point keeps what came before it
		setIdle(db);
		own(db.exec('DELETE FROM _wp_undo'));
		frameOpen = false;
		frameRow(db, armedReq, state);
		const work = deferred;
		deferred = [];
		for (const fn of work) {
			try { fn(); } catch (e) { log({ m: 'frame-deferred-failed', error: String((e && e.message) || e).slice(0, 160) }); }
		}
	}

	return {
		/** Arm a frame for this request (frames on). It opens at the first write. */
		arm(db, req) {
			if (!framesOn() || stranded) return; // #809: no frame opens over a stranded one
			armedReq = String(req || 'req-' + Date.now());
			points = 0;
			kinds = [];
			deferred = [];
		},
		frameOpen: () => frameOpen,
		/** #809: true while a stranded frame waits for a recovery that succeeds; writes are refused meanwhile. */
		stranded: () => stranded,
		phpTxnOpen: () => !!txnFrames,
		counts: () => ({ ...counts }),
		openedBy: () => openedBy,
		touch(k) {
			if (txnFrames) txnTouched.add(k);
		},
		/** Before every PHP statement: open the frame just before the first one that may write; a DDL is a commit point. */
		beforeStatement(db, sql, storage) {
			if (!armedReq) return;
			if (frameOpen && isDdl(sql)) return this.commitPoint(db, 'ddl');
			if (!frameOpen && mayWrite(sql) && !isDdl(sql)) frameOpenNow(db, sql, storage);
		},
		/**
		 * Run one PHP statement (fn runs it and returns its result). When it would open the frame, the open,
		 * the statement and its first undo row run in one storage transaction; if the statement left no undo
		 * row and reported no row written, the transaction is rolled back, so the open is never committed.
		 * The statement itself changed nothing, so rolling it back loses nothing: fn's result is returned as
		 * is (changes 0). An undo row decides, not the reported count alone (a counter may under-report).
		 */
		statement(db, storage, sql, fn) {
			if (stranded && mayWrite(sql)) throw new Error(STRANDED_ERROR);
			const opens = armedReq && !frameOpen && mayWrite(sql) && !isDdl(sql) && storage && typeof storage.transactionSync === 'function';
			if (!opens) {
				const was = frameOpen;
				this.beforeStatement(db, sql, storage);
				if (was && frameOpen && mayWrite(sql) && !isDdl(sql)) tagWriter(db);
				if (!was && frameOpen) log({ m: 'frame-open', req: armedReq, by: openedBy, tx: false });
				return fn();
			}
			const NOOP = {};
			const own0 = counts.own;
			let result;
			try {
				storage.transactionSync(() => {
					frameOpenNow(db, sql, storage);
					const seq = undoSeq(db);
					result = fn();
					const logged = db.exec('SELECT COUNT(*) AS n FROM _wp_undo WHERE seq > ?', seq).one().n;
					const written = result && typeof result.rowsWritten === 'number' ? result.rowsWritten : 0;
					if (logged === 0 && written === 0) throw NOOP;
				});
			} catch (e) {
				frameOpen = false;
				counts.opened--;
				openedBy = null;
				// undoTriggers may have created triggers inside the rolled-back transaction: check again next time.
				undoSchemaSig = null;
				setupDone = false;
				counts.own = own0; // the rolled-back transaction wrote nothing
				if (e !== NOOP) throw e;
				counts.noop++;
				return result;
			}
			log({ m: 'frame-open', req: armedReq, by: openedBy, tx: true });
			return result;
		},
		/** After a statement: a write while armed with no frame open is a MISS, counted and logged. */
		afterStatement(db, sql, rowsWritten) {
			if (armedReq && !frameOpen && rowsWritten > 0 && !isDdl(sql)) {
				counts.miss++;
				log({ m: 'frame-miss', req: armedReq, verb: (String(sql).match(/^\s*(\w+)/) || [, '?'])[1].toUpperCase(), rows: rowsWritten });
			}
		},
		/** Close the frame KEPT just before an effect that cannot be undone. */
		commitPoint(db, kind) {
			if (!armedReq || !frameOpen) return;
			points++;
			counts.points++;
			kinds.push(kind);
			frameKeep(db, 'open');
		},
		/** Run fn when the frame is kept; returns false (fn not taken) when no frame is open. */
		defer(fn) {
			if (!frameOpen) return false;
			deferred.push(fn);
			return true;
		},
		/** The request ended (PHP finished, a fatal included): a PHP transaction still open is rolled back, the frame kept. */
		/**
		 * #794: roll the open frame back NOW, in the request that met a reset-class storage failure in an isolate that
		 * survives. #352 keeps a frame at the request's end because the frame hides OUR platform's failure, not
		 * WordPress's; a storage failure at the memory ceiling is the platform's, and recover() rolls it back only in the
		 * NEXT isolate, which never comes when the object goes on. So it is undone here, as recover() would: back to the
		 * last commit point (what was kept at a point stays kept), the frame marked rolled-back (what /_frame proves), the
		 * deferred work (L2 sets) dropped, never run. Returns { undone, points } or null when no frame is open.
		 */
		rollbackFrame(db, storage) {
			if (!frameOpen) return null;
			let n;
			try {
				n = undoTo(db, storage, 0);
			} catch (e) {
				// #794 review: the undo met the same ceiling (likely: the request just failed there). Inside
				// transactionSync nothing of it applied, and the stored frame is intact (active = 1, its undo rows, its
				// row 'open'). It must never be KEPT: forget it in memory only (storage is failing; no write here), so
				// end() has nothing to keep, and run recover() again, which every request calls before PHP: the next
				// request in this isolate, or the next isolate, rolls it back.
				frameOpen = false;
				txnFrames = null;
				txnTouched.clear();
				deferred = [];
				armedReq = null;
				stateReq = null;
				recovered = false;
				stranded = true;
				counts.stranded = (counts.stranded || 0) + 1;
				log({ m: 'frame-stranded', error: String((e && e.message) || e).slice(0, 160) });
				throw e;
			}
			txnFrames = null;
			txnTouched.clear();
			setIdle(db);
			own(db.exec('DELETE FROM _wp_undo'));
			frameOpen = false;
			counts.rolledBack = (counts.rolledBack || 0) + 1;
			frameRow(db, armedReq, 'rolled-back');
			own(db.exec('UPDATE _wp_frame SET undone = ? WHERE req = ?', n, armedReq));
			deferred = [];
			const out = { undone: n, points, req: armedReq };
			armedReq = null; // end() must not mark it again
			return out;
		},
		end(db, storage) {
			if (txnFrames) {
				const n = undoTo(db, storage, txnFrames[0].seq);
				phpClose(db);
				if (frameOpen) setActive(db, true);
				log({ m: 'txn', rolledBackAtEnd: true, undone: n });
			}
			if (frameOpen) {
				counts.kept++;
				frameKeep(db, 'kept');
			} else if (armedReq && points > 0) {
				frameRow(db, armedReq, 'kept');
			}
			armedReq = null;
		},
		/** PHP's transaction ops (php/real-transactions.php). */
		txnOp(db, storage, op) {
			stats.txnOps++;
			try {
				const kind = op.op;
				if (kind === 'begin') {
					if (stranded) return { ok: false, error: STRANDED_ERROR }; // #809: its close would wipe the stranded undo
					if (txnFrames && !frameOpen) phpClose(db); // MySQL commits an open transaction first
					if (armedReq && !frameOpen) {
						frameOpenNow(db, undefined, storage);
						log({ m: 'frame-open', req: armedReq, by: openedBy, tx: false });
					}
					undoSetup(db, storage);
					undoTriggers(db);
					txnFrames = [{ name: null, seq: undoSeq(db) }];
					txnTouched.clear();
					setActive(db, true);
					return { ok: true };
				}
				if (kind === 'commit' || kind === 'ddl') {
					if (kind === 'ddl' && frameOpen) this.commitPoint(db, 'ddl');
					if (txnFrames) phpClose(db); // DDL: MySQL's implicit commit
					return { ok: true };
				}
				if (kind === 'rollback') {
					if (!txnFrames) return { ok: true };
					const n = undoTo(db, storage, txnFrames[0].seq);
					phpClose(db);
					if (frameOpen) setActive(db, true);
					return { ok: true, undone: n };
				}
				if (!txnFrames) return { ok: true }; // a savepoint outside a transaction does nothing (MySQL autocommit)
				const at = txnFrames.findIndex((f, i) => i > 0 && f.name === op.name);
				if (kind === 'savepoint') {
					if (at > 0) txnFrames.splice(at, 1); // MySQL: the same name replaces the old savepoint
					txnFrames.push({ name: op.name, seq: undoSeq(db) });
					return { ok: true };
				}
				if (at < 0) return { ok: false, error: `SAVEPOINT ${op.name} does not exist` };
				if (kind === 'rollback_to') {
					const n = undoTo(db, storage, txnFrames[at].seq);
					txnFrames.length = at + 1; // the savepoint stays, later ones go
					setActive(db, true);
					return { ok: true, undone: n };
				}
				if (kind === 'release') {
					txnFrames.length = at; // it and the later ones go; their changes stay in the transaction
					return { ok: true };
				}
				return { ok: false, error: 'unknown transaction op ' + kind };
			} catch (e) {
				return { ok: false, error: String((e && e.message) || e) };
			}
		},
		/** Once per isolate, before anything reads the database: undo what an isolate that died left open. */
		recover(db, storage) {
			if (recovered) return null;
			recovered = true;
			let active = 0;
			try {
				active = db.exec('SELECT active FROM _wp_undo_state WHERE id = 1').one().active;
			} catch {
				log({ m: 'frame-recover', active: 0, tables: false, frames: framesOn() });
				stranded = false;
				return null; // no undo tables yet: no transaction or frame was ever opened
			}
			if (!active) {
				const relabeled = relabelEnded(db);
				const rebuilt = migrateUndo(db, storage);
				log({ m: 'frame-recover', active: 0, tables: true, frames: framesOn(), relabeled, rebuilt });
				stranded = false;
				return null;
			}
			ensureReqCols(db);
			let n;
			try {
				n = undoTo(db, storage, 0, true);
			} catch (e) {
				recovered = false; // #794 review: not done; the next request tries again (the frame is still stored open)
				stranded = true; // #809: and nothing writes under it meanwhile
				throw e;
			}
			own(db.exec('DELETE FROM _wp_undo'));
			txnFrames = null;
			let req = null;
			try {
				const r = [...db.exec("SELECT req FROM _wp_frame WHERE state = 'open' ORDER BY t DESC, rowid DESC LIMIT 1").raw()];
				if (r.length) {
					req = r[0][0];
					own(db.exec("UPDATE _wp_frame SET state = 'rolled-back', undone = ? WHERE req = ?", n, req));
				}
			} catch {
				// frames were never on here
			}
			const relabeled = relabelEnded(db);
			const rebuilt = migrateUndo(db, storage);
			log({ m: 'txn', recovered: true, undone: n, req });
			// #684: what this recovery undid, per row: table, replayed op, rowid, and the request that wrote it.
			const shapes = lastUndone || [];
			lastUndone = null;
			const byReq = {};
			for (const r of shapes) byReq[r.req ?? 'null'] = (byReq[r.req ?? 'null'] || 0) + 1;
			log({ m: 'frame-recover-rows', frameReq: req, undone: n, rows: shapes.slice(0, RECOVER_ROWS_MAX), truncated: shapes.length > RECOVER_ROWS_MAX, byReq, cross: shapes.filter((r) => r.req !== req).length });
			log({ m: 'frame-recover', active: 1, tables: true, frames: framesOn(), undone: n, req, relabeled, rebuilt });
			stranded = false;
			return { undone: n, req };
		},
		/** The outcome of a request, for the Worker's /_frame probe: null when unknown. */
		status(db, req) {
			try {
				const r = [...db.exec('SELECT req, state, points, kinds, undone, t FROM _wp_frame WHERE req = ?', String(req)).raw()];
				if (!r.length) return null;
				const [q, state, p, k, undone, t] = r[0];
				return { req: q, state, points: p, kinds: k, undone, t };
			} catch {
				return null;
			}
		},
	};
}
