// node --test spikes/b2-wordpress/tests/code-store.test.mjs (issue #407)
// The code store against a REAL SQLite (node:sqlite) and a fake R2 bucket that can be made to fail at
// each step, so every crash window of the design is run. EVERY test runs twice: with the b-dosql
// index (sqliteIndex over the ctx.storage.sql shape) and with the approach-a index (mysqlIndex, its
// literal SQL executed by an engine that answers as mysql-*-bridge.js does). The MySQL adapter's
// SQL is the subset both engines accept; on a real MySQL it is checked by the approach-a run (#422).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { humanSize, codeKey, codeBudget, validSlug, cleanVersion, sha256Hex, putCode, deleteCode, loadCode, sweepOrphans, CodeMounter, sqliteIndex, mysqlIndex } from '../code-store.mjs';

const MIB = 1048576;

function sqliteKind() {
	const db = new DatabaseSync(':memory:');
	let failTxn = false;
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
	return { name: 'sqlite (b-dosql)', index: sqliteIndex(sql, txn), failIndexWrites: (v) => (failTxn = v), statements: null };
}

function mysqlKind() {
	const db = new DatabaseSync(':memory:');
	let failWrites = false;
	const statements = [];
	const run = async (q) => {
		statements.push(q);
		// The fault lands at COMMIT, after the row was written: only a real ROLLBACK removes it.
		if (failWrites && /^COMMIT/.test(q)) return { ok: false, error: 'Lost connection to MySQL server (injected)' };
		try {
			const st = db.prepare(q);
			if (/^\s*SELECT/i.test(q)) {
				const objs = st.all();
				const columns = objs.length ? Object.keys(objs[0]) : st.columns().map((c) => c.name);
				// Rows as arrays of strings, as the bridges answer (MySQL text protocol).
				return { ok: true, columns, rows: objs.map((o) => columns.map((c) => (o[c] === null ? null : String(o[c])))) };
			}
			st.run();
			return { ok: true, affected: 0 };
		} catch (e) {
			return { ok: false, error: String(e.message) };
		}
	};
	return { name: 'mysql (approach a)', index: mysqlIndex(run), failIndexWrites: (v) => (failWrites = v), statements };
}

const KINDS = [sqliteKind, mysqlKind];

function bucket() {
	const objs = new Map();
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

test('names, keys, sizes, versions and the budget', () => {
	assert.ok(validSlug('wordpress-seo'));
	assert.ok(validSlug('seo.by.rank-math'));
	for (const bad of ['', '.', '..', '../x', 'a/b', 'a..b', '-x', 'x'.repeat(101), 5, null]) assert.equal(validSlug(bad), false, String(bad));
	assert.throws(() => codeKey('plugin', 'a/b', 'f'.repeat(64)));
	assert.throws(() => codeKey('mu', 'a', 'f'.repeat(64)));
	assert.equal(codeKey('theme', 'astra', 'a'.repeat(64)), '_code/theme/astra/' + 'a'.repeat(64) + '.zip');
	assert.equal(cleanVersion("1.2'; DROP TABLE x;--"), '1.2DROPTABLEx--');
	assert.equal(cleanVersion('6.4.1-beta+2'), '6.4.1-beta+2');
	assert.equal(cleanVersion(''), null);
	assert.equal(humanSize(0), '0 KB');
	assert.equal(humanSize(1500), '2 KB');
	assert.equal(humanSize(MIB), '1.0 MB');
	assert.equal(humanSize(-5), '0 KB');
	// No default: the budget comes from measured headroom (#394), never a guess.
	assert.equal(codeBudget({}), null);
	assert.equal(codeBudget({ CODE_BUDGET_MB: '' }), null);
	assert.equal(codeBudget({ CODE_BUDGET_MB: 'lots' }), null);
	assert.equal(codeBudget({ CODE_BUDGET_MB: '-1' }), null);
	assert.equal(codeBudget({ CODE_BUDGET_MB: '0' }), 0);
	assert.equal(codeBudget({ CODE_BUDGET_MB: '2.5' }), Math.floor(2.5 * MIB));
});

for (const kind of KINDS) {
	const label = kind().name;

	test(`[${label}] put then load: the bytes come back verified, the generation moves`, async () => {
		const { index } = kind();
		const b = bucket();
		const zip = zipOf(1000);
		const r = await putCode({ index, bucket: b, type: 'plugin', slug: 'hello-dolly', version: '1.7.2', zip, files: 2, budget: MIB, now: 1 });
		assert.equal(r.ok, true);
		assert.equal(r.key, '_code/plugin/hello-dolly/' + (await sha256Hex(zip)) + '.zip');
		assert.equal(r.gen, 1);
		const rows = await index.rows();
		assert.deepEqual({ ...rows[0] }, { type: 'plugin', slug: 'hello-dolly', version: '1.7.2', key: r.key, sha256: r.sha256, bytes: 1000, files: 2, updated_at: 1 });
		const l = await loadCode({ index, bucket: b });
		assert.equal(l.mounted.length, 1);
		assert.deepEqual([...l.mounted[0].zip], [...zip]);
		assert.deepEqual(l.refused, []);
	});

	test(`[${label}] no budget set: refused in plain words, nothing written`, async () => {
		const { index } = kind();
		const b = bucket();
		const r = await putCode({ index, bucket: b, type: 'plugin', slug: 'x', zip: zipOf(10), budget: null, now: 1 });
		assert.equal(r.code, 'no-budget');
		assert.match(r.error, /CODE_BUDGET_MB/);
		assert.equal(b.objs.size, 0);
	});

	test(`[${label}] the budget at its boundary: exactly full is accepted, one byte over is refused`, async () => {
		const { index } = kind();
		const b = bucket();
		const budget = 3000;
		assert.equal((await putCode({ index, bucket: b, type: 'plugin', slug: 'a', zip: zipOf(1000, 1), budget, now: 1 })).ok, true);
		assert.equal((await putCode({ index, bucket: b, type: 'theme', slug: 'b', zip: zipOf(2000, 2), budget, now: 2 })).ok, true);
		const over = await putCode({ index, bucket: b, type: 'plugin', slug: 'c', zip: zipOf(1, 3), budget, now: 3 });
		assert.equal(over.code, 'budget');
		assert.match(over.error, /c needs 1 KB, and this site has 0 KB of room left/);
		assert.equal((await index.rows()).length, 2);
		assert.equal(b.objs.size, 2, 'a refused install writes no object');
		assert.equal((await putCode({ index, bucket: b, type: 'plugin', slug: 'a', zip: zipOf(1000, 9), budget, now: 4 })).ok, true, 'an update counts only the others');
		assert.equal((await putCode({ index, bucket: b, type: 'plugin', slug: 'a', zip: zipOf(1001, 8), budget, now: 5 })).ok, false);
	});

	test(`[${label}] crash window: object written, index write fails: never loaded, then swept`, async () => {
		const k = kind();
		const b = bucket();
		await k.index.gen(); // the tables exist before the fault
		k.failIndexWrites(true);
		b.fail.delete = true; // #449 deletes the orphan at once; after a reset that delete can fail too
		const r = await putCode({ index: k.index, bucket: b, type: 'plugin', slug: 'ghost', zip: zipOf(50), budget: MIB, now: 0 });
		b.fail.delete = false;
		k.failIndexWrites(false);
		assert.equal(r.code, 'index');
		assert.equal(b.objs.size, 1, 'the orphan object exists');
		assert.equal((await k.index.rows()).length, 0, 'the transaction left no row');
		assert.equal(await k.index.gen(), 0, 'the generation did not move');
		assert.deepEqual((await loadCode({ index: k.index, bucket: b })).mounted, []);
		assert.deepEqual(await sweepOrphans({ index: k.index, bucket: b, now: 60_000 }), [], 'inside the grace window it stays');
		assert.equal((await sweepOrphans({ index: k.index, bucket: b, now: 11 * 60_000 })).length, 1);
		assert.equal(b.objs.size, 0);
		assert.equal(await k.index.lastSweep(), 11 * 60_000);
	});

	test(`[${label}] #449: an index failure deletes the zip it just wrote, but never the live install's`, async () => {
		const k = kind();
		const b = bucket();
		await k.index.gen();
		k.failIndexWrites(true);
		const r = await putCode({ index: k.index, bucket: b, type: 'plugin', slug: 'big', zip: zipOf(70, 5), budget: MIB, now: 0 });
		k.failIndexWrites(false);
		assert.equal(r.code, 'index');
		assert.equal(b.objs.size, 0, 'no orphan is left behind');
		// A reinstall of the SAME content whose index write fails: that object is the live one, so it stays.
		const live = await putCode({ index: k.index, bucket: b, type: 'plugin', slug: 'same', zip: zipOf(40, 6), budget: MIB, now: 1 });
		assert.equal(live.ok, true);
		k.failIndexWrites(true);
		const again = await putCode({ index: k.index, bucket: b, type: 'plugin', slug: 'same', zip: zipOf(40, 6), budget: MIB, now: 2 });
		k.failIndexWrites(false);
		assert.equal(again.code, 'index');
		assert.equal(b.objs.has(live.key), true, 'the live object is not deleted');
		assert.equal((await loadCode({ index: k.index, bucket: b })).mounted.length, 1, 'and it still loads');
	});

	test(`[${label}] crash window: the R2 put fails: refused, nothing recorded`, async () => {
		const { index } = kind();
		const b = bucket();
		b.fail.put = true;
		const r = await putCode({ index, bucket: b, type: 'plugin', slug: 'p', zip: zipOf(5), budget: MIB, now: 1 });
		assert.equal(r.code, 'store');
		assert.equal((await index.rows()).length, 0);
	});

	test(`[${label}] crash window: a row with no object is refused at boot, with a reason`, async () => {
		const { index } = kind();
		const b = bucket();
		await putCode({ index, bucket: b, type: 'plugin', slug: 'gone', zip: zipOf(20), budget: MIB, now: 1 });
		b.objs.clear();
		const l = await loadCode({ index, bucket: b });
		assert.deepEqual(l.mounted, []);
		assert.deepEqual(l.refused, [{ type: 'plugin', slug: 'gone', reason: 'missing' }]);
	});

	test(`[${label}] a changed or truncated object is refused, never run`, async () => {
		const { index } = kind();
		const b = bucket();
		const r = await putCode({ index, bucket: b, type: 'plugin', slug: 'p', zip: zipOf(100, 4), budget: MIB, now: 1 });
		b.objs.get(r.key).bytes[10] = 5;
		assert.deepEqual((await loadCode({ index, bucket: b })).refused, [{ type: 'plugin', slug: 'p', reason: 'damaged' }]);
		b.objs.get(r.key).bytes = b.objs.get(r.key).bytes.slice(0, 50);
		assert.deepEqual((await loadCode({ index, bucket: b })).refused, [{ type: 'plugin', slug: 'p', reason: 'damaged' }]);
		b.fail.get = true;
		assert.deepEqual((await loadCode({ index, bucket: b })).refused, [{ type: 'plugin', slug: 'p', reason: 'unreadable' }]);
	});

	test(`[${label}] an update replaces the row and removes the old object; a failed old delete is swept later`, async () => {
		const { index } = kind();
		const b = bucket();
		const v1 = await putCode({ index, bucket: b, type: 'plugin', slug: 'p', version: '1', zip: zipOf(10, 1), budget: MIB, now: 0 });
		const v2 = await putCode({ index, bucket: b, type: 'plugin', slug: 'p', version: '2', zip: zipOf(10, 2), budget: MIB, now: 1 });
		assert.notEqual(v1.key, v2.key);
		assert.equal(b.objs.has(v1.key), false);
		assert.equal((await index.rows())[0].version, '2');
		b.fail.delete = true;
		const v3 = await putCode({ index, bucket: b, type: 'plugin', slug: 'p', version: '3', zip: zipOf(10, 3), budget: MIB, now: 2 });
		b.fail.delete = false;
		assert.equal(v3.ok, true);
		assert.equal(b.objs.has(v2.key), true);
		assert.deepEqual(await sweepOrphans({ index, bucket: b, now: 60 * 60_000 }), [v2.key]);
		assert.equal(b.objs.has(v3.key), true, 'the live object is never swept');
	});

	test(`[${label}] crash window: a delete mid-way (row gone, object delete failed): not loaded, swept`, async () => {
		const { index } = kind();
		const b = bucket();
		const r = await putCode({ index, bucket: b, type: 'theme', slug: 't', zip: zipOf(30), budget: MIB, now: 0 });
		b.fail.delete = true;
		const d = await deleteCode({ index, bucket: b, type: 'theme', slug: 't' });
		b.fail.delete = false;
		assert.equal(d.ok, true);
		assert.equal(d.gen, 2);
		assert.deepEqual((await loadCode({ index, bucket: b })).mounted, []);
		assert.deepEqual(await sweepOrphans({ index, bucket: b, now: 60 * 60_000 }), [r.key]);
		assert.equal((await deleteCode({ index, bucket: b, type: 'theme', slug: 't' })).none, true, 'deleting twice is a no-op');
	});

	test(`[${label}] a generation bump made by one runtime is seen by a second (another isolate)`, async () => {
		const { index } = kind();
		const b = bucket();
		const fsA = new Map();
		const fsB = new Map();
		const ops = (fs) => ({ mount: (t, s, z) => fs.set(`${t}/${s}`, z.length), unmount: (t, s) => fs.delete(`${t}/${s}`) });
		const A = new CodeMounter();
		const B = new CodeMounter();
		await A.sync({ index, bucket: b, ...ops(fsA) });
		await B.sync({ index, bucket: b, ...ops(fsB) });
		assert.equal((await B.sync({ index, bucket: b, ...ops(fsB) })).changed, false);
		const zip = zipOf(64);
		const r = await putCode({ index, bucket: b, type: 'plugin', slug: 'new', zip, budget: MIB, now: 1 });
		A.adopt({ type: 'plugin', slug: 'new', sha256: r.sha256, zip, gen: r.gen, ...ops(fsA) });
		assert.equal(A.gen, 1);
		assert.equal((await A.sync({ index, bucket: b, ...ops(fsA) })).changed, false, 'the installer is current');
		assert.equal((await B.sync({ index, bucket: b, ...ops(fsB) })).changed, true);
		assert.equal(fsB.get('plugin/new'), 64);
		const d = await deleteCode({ index, bucket: b, type: 'plugin', slug: 'new' });
		A.forget({ type: 'plugin', slug: 'new', gen: d.gen, ...ops(fsA) });
		assert.equal(fsA.has('plugin/new'), false);
		await B.sync({ index, bucket: b, ...ops(fsB) });
		assert.equal(fsB.has('plugin/new'), false);
		const r2 = await putCode({ index, bucket: b, type: 'plugin', slug: 'later', zip: zipOf(8), budget: MIB, now: 2 });
		await B.sync({ index, bucket: b, ...ops(fsB) });
		assert.equal(fsB.has('plugin/later'), true);
		b.objs.delete(r2.key);
		await putCode({ index, bucket: b, type: 'theme', slug: 'other', zip: zipOf(9), budget: MIB, now: 3 });
		const s = await B.sync({ index, bucket: b, ...ops(fsB) });
		assert.equal(fsB.has('plugin/later'), false, 'a copy that went missing is unmounted');
		assert.deepEqual(s.refused, [{ type: 'plugin', slug: 'later', reason: 'missing' }]);
	});

	test(`[${label}] bad names never reach storage`, async () => {
		const { index } = kind();
		const b = bucket();
		for (const slug of ['../wp-config', 'a/b', '.htaccess', "x'y"]) {
			const r = await putCode({ index, bucket: b, type: 'plugin', slug, zip: zipOf(1), budget: MIB, now: 1 });
			assert.equal(r.code, 'bad-name', slug);
		}
		assert.equal((await putCode({ index, bucket: b, type: 'mu-plugin', slug: 'x', zip: zipOf(1), budget: MIB, now: 1 })).code, 'bad-name');
		assert.equal(b.objs.size, 0);
		assert.equal((await index.rows()).length, 0);
	});
}

test('[mysql (approach a)] every statement is a literal with no quote or backslash from a value', async () => {
	const k = mysqlKind();
	const b = bucket();
	assert.equal((await putCode({ index: k.index, bucket: b, type: 'plugin', slug: 'seo.by.rank-math', version: "9'; DROP TABLE pf_code;--", zip: zipOf(5), budget: MIB, now: 7 })).ok, true);
	await deleteCode({ index: k.index, bucket: b, type: 'plugin', slug: 'seo.by.rank-math' });
	for (const s of k.statements) {
		const quoted = s.match(/'[^']*'/g) || [];
		for (const q of quoted) assert.match(q, /^'[A-Za-z0-9._+\/-]*'$/, s);
		assert.ok(!s.includes('\\'), s);
	}
	assert.ok(k.statements.some((s) => s.startsWith('BEGIN')) && k.statements.some((s) => s.startsWith('COMMIT')), 'writes are in a transaction');
});

test('[mysql (approach a)] a mounter with a check interval reads the generation at most once per interval', async () => {
	const k = mysqlKind();
	const b = bucket();
	const m = new CodeMounter({ minIntervalMs: 5000 });
	const ops = { mount: () => {}, unmount: () => {} };
	await m.sync({ index: k.index, bucket: b, ...ops, now: 0 });
	const n0 = k.statements.length;
	assert.equal((await m.sync({ index: k.index, bucket: b, ...ops, now: 4999 })).skipped, true);
	assert.equal(k.statements.length, n0, 'no query inside the interval');
	await m.sync({ index: k.index, bucket: b, ...ops, now: 5000 });
	assert.ok(k.statements.length > n0, 'one read after it');
});
