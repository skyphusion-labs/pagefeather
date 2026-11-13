// node --test spikes/b2-wordpress/tests/code-store.test.mjs (issue #407)
// The code store against a REAL SQLite (node:sqlite, the same engine as a Durable Object's) and a
// fake R2 bucket that can be made to fail at each step, so every crash window of the design is run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { humanSize, codeKey, codeBudget, validSlug, sha256Hex, putCode, deleteCode, loadCode, sweepOrphans, CodeMounter, readRows, readGen, ensureSchema } from '../code-store.mjs';

const MIB = 1048576;

// ctx.storage.sql's shape: exec(sql, ...params) returns a cursor with toArray().
function storage() {
	const db = new DatabaseSync(':memory:');
	const sql = {
		exec(q, ...params) {
			const st = db.prepare(q);
			if (/^\s*(SELECT|WITH)/i.test(q)) {
				const rows = st.all(...params);
				return { toArray: () => rows };
			}
			st.run(...params);
			return { toArray: () => [] };
		},
	};
	let failTxn = false;
	const txn = (fn) => {
		if (failTxn) throw new Error('storage reset (injected)');
		db.exec('BEGIN');
		try {
			fn();
			db.exec('COMMIT');
		} catch (e) {
			db.exec('ROLLBACK');
			throw e;
		}
	};
	return { sql, txn, failTxnNext: (v) => (failTxn = v) };
}

function bucket() {
	const objs = new Map(); // key -> { bytes, uploaded }
	const fail = { put: false, delete: false, get: false };
	let clock = 0;
	return {
		objs,
		fail,
		setClock: (t) => (clock = t),
		async put(key, bytes, opts) {
			if (fail.put) throw new Error('R2 put failed (injected)');
			if (opts && opts.sha256 && opts.sha256 !== (await sha256Hex(bytes))) throw new Error('sha256 mismatch on put');
			objs.set(key, { bytes: new Uint8Array(bytes), uploaded: new Date(clock) });
		},
		async get(key) {
			if (fail.get) throw new Error('R2 get failed (injected)');
			const o = objs.get(key);
			return o ? { arrayBuffer: async () => o.bytes.slice().buffer } : null;
		},
		async delete(key) {
			if (fail.delete) throw new Error('R2 delete failed (injected)');
			objs.delete(key);
		},
		async list({ prefix, cursor }) {
			const all = [...objs.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, uploaded: o.uploaded }));
			const start = cursor ? Number(cursor) : 0;
			const page = all.slice(start, start + 2); // tiny pages, so pagination is exercised
			return { objects: page, truncated: start + 2 < all.length, cursor: String(start + 2) };
		},
	};
}

const zipOf = (n, fill = 7) => new Uint8Array(n).fill(fill);

test('names, keys and the budget', () => {
	assert.ok(validSlug('wordpress-seo'));
	assert.ok(validSlug('seo.by.rank-math'));
	for (const bad of ['', '.', '..', '../x', 'a/b', 'a..b', '-x', 'x'.repeat(101), 5, null]) assert.equal(validSlug(bad), false, String(bad));
	assert.throws(() => codeKey('plugin', 'a/b', 'f'.repeat(64)));
	assert.throws(() => codeKey('mu', 'a', 'f'.repeat(64)));
	assert.equal(codeKey('theme', 'astra', 'a'.repeat(64)), '_code/theme/astra/' + 'a'.repeat(64) + '.zip');
	// No default: the budget comes from measured headroom (#394), never a guess.
	assert.equal(codeBudget({}), null);
	assert.equal(codeBudget({ CODE_BUDGET_MB: '' }), null);
	assert.equal(codeBudget({ CODE_BUDGET_MB: 'lots' }), null);
	assert.equal(codeBudget({ CODE_BUDGET_MB: '-1' }), null);
	assert.equal(codeBudget({ CODE_BUDGET_MB: '0' }), 0);
	assert.equal(codeBudget({ CODE_BUDGET_MB: '2.5' }), Math.floor(2.5 * MIB));
	assert.equal(humanSize(0), '0 KB');
	assert.equal(humanSize(1500), '2 KB');
	assert.equal(humanSize(MIB), '1.0 MB');
	assert.equal(humanSize(-5), '0 KB');
});

test('put then load: the bytes come back verified, the generation moves', async () => {
	const { sql, txn } = storage();
	const b = bucket();
	const zip = zipOf(1000);
	const r = await putCode({ sql, txn, bucket: b, type: 'plugin', slug: 'hello-dolly', version: '1.7.2', zip, files: 2, budget: MIB, now: 1 });
	assert.equal(r.ok, true);
	assert.equal(r.key, '_code/plugin/hello-dolly/' + (await sha256Hex(zip)) + '.zip');
	assert.equal(r.gen, 1);
	const l = await loadCode({ sql, bucket: b });
	assert.equal(l.mounted.length, 1);
	assert.deepEqual([...l.mounted[0].zip], [...zip]);
	assert.deepEqual(l.refused, []);
});

test('no budget set: refused in plain words, nothing written', async () => {
	const { sql, txn } = storage();
	const b = bucket();
	const r = await putCode({ sql, txn, bucket: b, type: 'plugin', slug: 'x', zip: zipOf(10), budget: null, now: 1 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'no-budget');
	assert.match(r.error, /CODE_BUDGET_MB/);
	assert.equal(b.objs.size, 0);
});

test('the budget at its boundary: exactly full is accepted, one byte over is refused', async () => {
	const { sql, txn } = storage();
	const b = bucket();
	const budget = 3000;
	assert.equal((await putCode({ sql, txn, bucket: b, type: 'plugin', slug: 'a', zip: zipOf(1000, 1), budget, now: 1 })).ok, true);
	assert.equal((await putCode({ sql, txn, bucket: b, type: 'theme', slug: 'b', zip: zipOf(2000, 2), budget, now: 2 })).ok, true); // 3000 of 3000
	const over = await putCode({ sql, txn, bucket: b, type: 'plugin', slug: 'c', zip: zipOf(1, 3), budget, now: 3 });
	assert.equal(over.ok, false);
	assert.equal(over.code, 'budget');
	assert.match(over.error, /c needs 1 KB, and this site has 0 KB of room left/);
	assert.equal(readRows(sql).length, 2);
	assert.equal(b.objs.size, 2, 'a refused install writes no object');
	// An UPDATE of a stored plugin counts only the others: a to 1000 bytes again still fits exactly.
	assert.equal((await putCode({ sql, txn, bucket: b, type: 'plugin', slug: 'a', zip: zipOf(1000, 9), budget, now: 4 })).ok, true);
	assert.equal((await putCode({ sql, txn, bucket: b, type: 'plugin', slug: 'a', zip: zipOf(1001, 8), budget, now: 5 })).ok, false);
});

test('crash window: object written, row not (storage reset): never loaded, then swept', async () => {
	const st = storage();
	const b = bucket();
	b.setClock(0);
	st.failTxnNext(true);
	const r = await putCode({ ...st, bucket: b, type: 'plugin', slug: 'ghost', zip: zipOf(50), budget: MIB, now: 0 });
	st.failTxnNext(false);
	assert.equal(r.ok, false);
	assert.equal(r.code, 'index');
	assert.equal(b.objs.size, 1, 'the orphan object exists');
	assert.equal(readRows(st.sql).length, 0);
	assert.equal(readGen(st.sql), 0, 'the generation did not move');
	assert.deepEqual((await loadCode({ sql: st.sql, bucket: b })).mounted, [], 'boot does not load it');
	// Inside the grace window the sweep leaves it (an install in flight looks the same).
	assert.deepEqual(await sweepOrphans({ sql: st.sql, bucket: b, now: 60_000 }), []);
	assert.equal((await sweepOrphans({ sql: st.sql, bucket: b, now: 11 * 60_000 })).length, 1);
	assert.equal(b.objs.size, 0);
});

test('crash window: the R2 put fails: refused, nothing recorded', async () => {
	const { sql, txn } = storage();
	const b = bucket();
	b.fail.put = true;
	const r = await putCode({ sql, txn, bucket: b, type: 'plugin', slug: 'p', zip: zipOf(5), budget: MIB, now: 1 });
	assert.equal(r.ok, false);
	assert.equal(r.code, 'store');
	assert.equal(readRows(sql).length, 0);
});

test('crash window: a row with no object is refused at boot, in plain reasons', async () => {
	const { sql, txn } = storage();
	const b = bucket();
	await putCode({ sql, txn, bucket: b, type: 'plugin', slug: 'gone', zip: zipOf(20), budget: MIB, now: 1 });
	b.objs.clear(); // the object vanished
	const l = await loadCode({ sql, bucket: b });
	assert.deepEqual(l.mounted, []);
	assert.deepEqual(l.refused, [{ type: 'plugin', slug: 'gone', reason: 'missing' }]);
});

test('a changed or truncated object is refused, never run', async () => {
	const { sql, txn } = storage();
	const b = bucket();
	const r = await putCode({ sql, txn, bucket: b, type: 'plugin', slug: 'p', zip: zipOf(100, 4), budget: MIB, now: 1 });
	b.objs.get(r.key).bytes[10] = 5; // one byte changed, same size
	assert.deepEqual((await loadCode({ sql, bucket: b })).refused, [{ type: 'plugin', slug: 'p', reason: 'damaged' }]);
	b.objs.get(r.key).bytes = b.objs.get(r.key).bytes.slice(0, 50); // truncated
	assert.deepEqual((await loadCode({ sql, bucket: b })).refused, [{ type: 'plugin', slug: 'p', reason: 'damaged' }]);
	b.fail.get = true;
	assert.deepEqual((await loadCode({ sql, bucket: b })).refused, [{ type: 'plugin', slug: 'p', reason: 'unreadable' }]);
});

test('an update replaces the row and removes the old object; a failed old delete is swept later', async () => {
	const { sql, txn } = storage();
	const b = bucket();
	const v1 = await putCode({ sql, txn, bucket: b, type: 'plugin', slug: 'p', version: '1', zip: zipOf(10, 1), budget: MIB, now: 0 });
	const v2 = await putCode({ sql, txn, bucket: b, type: 'plugin', slug: 'p', version: '2', zip: zipOf(10, 2), budget: MIB, now: 1 });
	assert.notEqual(v1.key, v2.key);
	assert.equal(b.objs.has(v1.key), false);
	assert.equal(readRows(sql)[0].version, '2');
	b.fail.delete = true;
	const v3 = await putCode({ sql, txn, bucket: b, type: 'plugin', slug: 'p', version: '3', zip: zipOf(10, 3), budget: MIB, now: 2 });
	b.fail.delete = false;
	assert.equal(v3.ok, true);
	assert.equal(b.objs.has(v2.key), true, 'the old object is an orphan now');
	assert.deepEqual(await sweepOrphans({ sql, bucket: b, now: 60 * 60_000 }), [v2.key]);
	assert.equal(b.objs.has(v3.key), true, 'the live object is never swept');
});

test('crash window: a delete mid-way (row gone, object delete failed): not loaded, swept', async () => {
	const { sql, txn } = storage();
	const b = bucket();
	const r = await putCode({ sql, txn, bucket: b, type: 'theme', slug: 't', zip: zipOf(30), budget: MIB, now: 0 });
	b.fail.delete = true;
	const d = await deleteCode({ sql, txn, bucket: b, type: 'theme', slug: 't' });
	b.fail.delete = false;
	assert.equal(d.ok, true);
	assert.equal(d.gen, 2);
	assert.deepEqual((await loadCode({ sql, bucket: b })).mounted, []);
	assert.deepEqual(await sweepOrphans({ sql, bucket: b, now: 60 * 60_000 }), [r.key]);
	assert.equal((await deleteCode({ sql, txn, bucket: b, type: 'theme', slug: 't' })).none, true, 'deleting twice is a no-op');
});

test('a generation bump made by one runtime is seen by a second (another isolate)', async () => {
	const { sql, txn } = storage();
	const b = bucket();
	const fsA = new Map();
	const fsB = new Map();
	const ops = (fs) => ({ mount: (t, s, z) => fs.set(`${t}/${s}`, z.length), unmount: (t, s) => fs.delete(`${t}/${s}`) });
	const A = new CodeMounter();
	const B = new CodeMounter();
	await A.sync({ sql, bucket: b, ...ops(fsA) });
	await B.sync({ sql, bucket: b, ...ops(fsB) });
	assert.equal((await B.sync({ sql, bucket: b, ...ops(fsB) })).changed, false, 'no change, no reload');
	// A installs: it stores, then adopts its own bytes.
	const zip = zipOf(64);
	const r = await putCode({ sql, txn, bucket: b, type: 'plugin', slug: 'new', zip, budget: MIB, now: 1 });
	A.adopt({ type: 'plugin', slug: 'new', sha256: r.sha256, zip, gen: r.gen, ...ops(fsA) });
	assert.equal(A.gen, 1);
	assert.equal((await A.sync({ sql, bucket: b, ...ops(fsA) })).changed, false, 'the installer is current');
	// B sees it at its next request.
	assert.equal((await B.sync({ sql, bucket: b, ...ops(fsB) })).changed, true);
	assert.equal(fsB.get('plugin/new'), 64);
	// A deletes; B unmounts at its next request.
	const d = await deleteCode({ sql, txn, bucket: b, type: 'plugin', slug: 'new' });
	A.forget({ type: 'plugin', slug: 'new', gen: d.gen, ...ops(fsA) });
	assert.equal(fsA.has('plugin/new'), false);
	await B.sync({ sql, bucket: b, ...ops(fsB) });
	assert.equal(fsB.has('plugin/new'), false);
	// A stored object that goes missing is unmounted and reported at the next change.
	const r2 = await putCode({ sql, txn, bucket: b, type: 'plugin', slug: 'later', zip: zipOf(8), budget: MIB, now: 2 });
	await B.sync({ sql, bucket: b, ...ops(fsB) });
	assert.equal(fsB.has('plugin/later'), true);
	b.objs.delete(r2.key);
	await putCode({ sql, txn, bucket: b, type: 'theme', slug: 'other', zip: zipOf(9), budget: MIB, now: 3 });
	const s = await B.sync({ sql, bucket: b, ...ops(fsB) });
	assert.equal(fsB.has('plugin/later'), false);
	assert.deepEqual(s.refused, [{ type: 'plugin', slug: 'later', reason: 'missing' }]);
});

test('bad names never reach storage', async () => {
	const { sql, txn } = storage();
	const b = bucket();
	for (const slug of ['../wp-config', 'a/b', '.htaccess']) {
		const r = await putCode({ sql, txn, bucket: b, type: 'plugin', slug, zip: zipOf(1), budget: MIB, now: 1 });
		assert.equal(r.code, 'bad-name', slug);
	}
	assert.equal((await putCode({ sql, txn, bucket: b, type: 'mu-plugin', slug: 'x', zip: zipOf(1), budget: MIB, now: 1 })).code, 'bad-name');
	assert.equal(b.objs.size, 0);
	ensureSchema(sql);
	assert.equal(readRows(sql).length, 0);
});
