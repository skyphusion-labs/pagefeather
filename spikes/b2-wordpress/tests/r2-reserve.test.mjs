// Issue #946. A deleted upload must free its row in _r2_reserved.
// index.js cannot be imported (cloudflare:workers, the wasm build), so the
// delete and move branches are checked as shipped source. The reserve and
// release functions run here against a SQL driver.
//   node --test spikes/b2-wordpress/tests/r2-reserve.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releaseReservedName, releaseReservedD1, tryReserveName, RESERVE_DDL, RESERVE_INSERT, RESERVE_DELETE } from '../r2-reserve.mjs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const KEY = 'uploads/2026/11/image-01.jpg';
const OTHER = 'uploads/2026/11/image-02.png';

function between(startMark, endMark) {
	const s = src.indexOf(startMark);
	const e = src.indexOf(endMark, s + startMark.length);
	assert.ok(s >= 0 && e > s, 'missing ' + startMark + ' .. ' + endMark);
	return src.slice(s, e);
}

// The same changes count index.js sqlChanges uses. A duplicate INSERT OR IGNORE is 0.
function sqlChanges(db, run) {
	const before = db.exec('SELECT total_changes()').raw().next().value[0];
	run();
	const after = db.exec('SELECT total_changes()').raw().next().value[0];
	return after === before ? 0 : db.exec('SELECT changes()').raw().next().value[0];
}

function cursor(rows) {
	return { raw() { return rows.values(); } };
}

// Applies the reservation statements. Unexpected SQL throws, so a drifted string fails.
function memorySql() {
	let table = null;
	let total = 0;
	let last = 0;
	const seen = [];
	return {
		seen,
		exec(sql, ...params) {
			const s = String(sql).replace(/\s+/g, ' ').trim();
			seen.push(s);
			if (s === 'SELECT total_changes()') return cursor([[total]]);
			if (s === 'SELECT changes()') return cursor([[last]]);
			if (s === RESERVE_DDL) {
				if (!table) table = new Map();
				last = 0;
				return cursor([]);
			}
			if (s === RESERVE_INSERT) {
				if (!table) throw new Error('no such table: _r2_reserved');
				if (table.has(params[0])) {
					last = 0;
				} else {
					table.set(params[0], params[1]);
					last = 1;
					total += 1;
				}
				return cursor([]);
			}
			if (s === RESERVE_DELETE) {
				if (!table) throw new Error('no such table: _r2_reserved');
				if (table.delete(params[0])) {
					last = 1;
					total += 1;
				} else {
					last = 0;
				}
				return cursor([]);
			}
			throw new Error('unexpected sql: ' + s);
		},
	};
}

function reserve(db, key, exists) {
	return tryReserveName(db, key, exists, 1, sqlChanges);
}

test('a free name is reserved once, and a second caller does not get it', () => {
	const db = memorySql();
	assert.equal(reserve(db, KEY, false), true);
	assert.equal(reserve(db, KEY, false), false);
});

test('delete releases that name and leaves a different name reserved', () => {
	const db = memorySql();
	assert.equal(reserve(db, KEY, false), true);
	assert.equal(reserve(db, OTHER, false), true);
	releaseReservedName(db, KEY);
	assert.ok(db.seen.includes(RESERVE_DELETE), 'release did not delete the row');
	assert.equal(reserve(db, KEY, false), true);
	assert.equal(reserve(db, OTHER, false), false);
});

test('an object that is still in R2 is not reserved, and a later upload can take the name', () => {
	const db = memorySql();
	assert.equal(reserve(db, KEY, true), false);
	assert.equal(reserve(db, KEY, false), true);
});

test('release before any reserve does not throw, and the name can then be reserved', () => {
	const db = memorySql();
	releaseReservedName(db, KEY);
	assert.equal(reserve(db, KEY, false), true);
});

test('D1 release deletes the bound key, ignores a missing table, and rethrows other errors', async () => {
	const ran = [];
	const db = {
		prepare(sql) {
			assert.equal(sql, RESERVE_DELETE);
			return { bind(key) { return { async run() { ran.push(key); } }; } };
		},
	};
	await releaseReservedD1(db, KEY);
	assert.deepEqual(ran, [KEY]);
	const missing = {
		prepare() {
			return { bind() { return { async run() { throw new Error('no such table: _r2_reserved'); } }; } };
		},
	};
	await releaseReservedD1(missing, KEY);
	const other = {
		prepare() {
			return { bind() { return { async run() { throw new Error('D1 is down'); } }; } };
		},
	};
	await assert.rejects(() => releaseReservedD1(other, KEY), /D1 is down/);
});

test('the worker frees the name before it deletes the object, on delete and on move', () => {
	const del = between("if (op.op === 'delete')", "if (op.op === 'info')");
	const delRel = del.indexOf('await releaseReservedKey(op.key)');
	const delGone = del.indexOf('await B.delete(op.key)');
	assert.ok(delRel >= 0 && delGone > delRel, 'delete does not free the name before it removes the object');
	const copy = between("if (op.op === 'copy')", "if (op.op === 'delete')");
	const moveRel = copy.indexOf('await releaseReservedKey(op.from)');
	const moveGone = copy.indexOf('await B.delete(op.from)');
	assert.ok(moveRel >= 0 && moveGone > moveRel, 'a move does not free the old name before it removes the old object');
	const fn = between('async function releaseReservedKey', 'function b64encode');
	assert.match(fn, /releaseReservedName\(sqlDb, key\)/);
	assert.match(fn, /releaseReservedD1\(ENV\.DB, key\)/);
	const reserve = between("if (op.op === 'reserve' && sqlDb)", "if (op.op === 'reserve')");
	assert.match(reserve, /tryReserveName\(sqlDb/);
});

// The same cases on node:sqlite when this Node has the builtin. The memory driver above is the gate.
let DatabaseSync = null;
try {
	({ DatabaseSync } = await import('node:sqlite'));
} catch {
	DatabaseSync = null;
}

function nodeSqlite() {
	const raw = new DatabaseSync(':memory:');
	return {
		exec(sql, ...params) {
			const stmt = raw.prepare(sql);
			if (String(sql).trim().toUpperCase().startsWith('SELECT')) {
				const rows = stmt.all(...params).map((row) => Object.values(row));
				return cursor(rows);
			}
			stmt.run(...params);
			return cursor([]);
		},
	};
}

test('node:sqlite: delete releases the name', { skip: DatabaseSync ? false : 'this Node has no node:sqlite' }, () => {
	const db = nodeSqlite();
	assert.equal(reserve(db, KEY, false), true);
	assert.equal(reserve(db, KEY, false), false);
	releaseReservedName(db, KEY);
	assert.equal(reserve(db, KEY, false), true);
	assert.equal(reserve(db, OTHER, false), true);
	releaseReservedName(db, KEY);
	assert.equal(reserve(db, OTHER, false), false);
});
