// page-versions.mjs (#296 step 1): exact invalidation for the #63 page cache on approach A.
// A fake MySQL keeps the schema and the counter as state; a fake edge cache is a Map keyed on the
// URL, as the Workers Cache keys the Pages entrypoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	PCV_PARAM, ORDER_TYPES, versionTable, triggerNames, triggerSql, install, status, remove,
	readPageVersion, versionedUrl, stripPcv, pageVersionsOn, cell,
} from '../page-versions.mjs';

const b64 = (s) => ({ $b: Buffer.from(String(s)).toString('base64') });
function fakeDb({ refuseTrigger = null, binary = false } = {}) {
	const db = { tables: new Set(), v: null, triggers: new Set(), log: [] };
	db.q = async (sql) => {
		db.log.push(sql);
		let m;
		if ((m = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/))) { db.tables.add(m[1]); return { ok: true, affected: 0 }; }
		if ((m = sql.match(/^INSERT IGNORE INTO (\w+) \(grp, v\) VALUES \('pages', 0\)$/))) { if (db.v === null) db.v = 0; return { ok: true }; }
		if ((m = sql.match(/^DROP TRIGGER IF EXISTS (\w+)$/))) { db.triggers.delete(m[1]); return { ok: true }; }
		if ((m = sql.match(/^CREATE TRIGGER (\w+) AFTER (INSERT|UPDATE|DELETE) ON (\w+) FOR EACH ROW /))) {
			if (refuseTrigger && refuseTrigger(m[1])) return { ok: false, errno: 1235, error: 'This version of MySQL does not yet support triggers' };
			db.triggers.add(m[1]); return { ok: true };
		}
		if ((m = sql.match(/^DROP TABLE IF EXISTS (\w+)$/))) { db.tables.delete(m[1]); db.v = null; return { ok: true }; }
		if ((m = sql.match(/information_schema\.tables .* table_name = '(\w+)'/))) return { ok: true, rows: [[binary ? b64(db.tables.has(m[1]) ? 1 : 0) : (db.tables.has(m[1]) ? '1' : '0')]] };
		if (/information_schema\.triggers/.test(sql)) return { ok: true, rows: [...db.triggers].map((t) => [t]) };
		if ((m = sql.match(/^SELECT v FROM (\w+) WHERE grp = 'pages'$/))) return db.tables.has(m[1]) ? { ok: true, rows: db.v === null ? [] : [[binary ? b64(db.v) : String(db.v)]] } : { ok: false, errno: 1146, error: 'no table' };
		return { ok: false, error: 'fake: unexpected SQL ' + sql.slice(0, 60) };
	};
	return db;
}

test('the trigger set: 7 tables x 3 events, each one statement, named under the prefix', () => {
	const t = triggerSql('wp_');
	assert.equal(t.length, 21);
	assert.deepEqual(t.map((x) => x.name), triggerNames('wp_'));
	for (const x of t) {
		assert.match(x.sql, /^CREATE TRIGGER wp_skyph_pv_\w+ AFTER (INSERT|UPDATE|DELETE) ON wp_\w+ FOR EACH ROW /);
		assert.ok(x.sql.includes(`UPDATE ${versionTable('wp_')} SET v = v + 1 WHERE grp = 'pages'`), x.name);
		assert.ok(!/;\s*(CREATE|DROP|SELECT)/i.test(x.sql), 'one statement: ' + x.name);
	}
	for (const tb of ['options', 'posts', 'postmeta', 'comments', 'terms', 'term_taxonomy', 'term_relationships'])
		assert.equal(t.filter((x) => x.sql.includes(` ON wp_${tb} FOR`)).length, 3, tb);
});

test('the skips: transients and cron, orders and revisions, edit locks and order meta, order notes', () => {
	const by = (tb, ev) => triggerSql('wp_').find((x) => x.sql.includes(`AFTER ${ev} ON wp_${tb} FOR`)).sql;
	const o = by('options', 'UPDATE');
	assert.ok(o.includes("NEW.option_name NOT LIKE '\\_transient\\_%'"));
	assert.ok(o.includes("NEW.option_name NOT LIKE '\\_site\\_transient\\_%'"));
	assert.ok(o.includes("NEW.option_name <> 'cron'"));
	assert.ok(by('options', 'DELETE').includes('OLD.option_name'));
	const p = by('posts', 'INSERT');
	for (const ty of [...ORDER_TYPES, 'scheduled-action', 'revision', 'customize_changeset', 'oembed_cache']) assert.ok(p.includes(`'${ty}'`), ty);
	assert.ok(p.includes("NEW.post_status <> 'auto-draft'"));
	const pm = by('postmeta', 'UPDATE');
	assert.ok(pm.includes("NEW.meta_key NOT IN ('_edit_lock', '_edit_last')"));
	assert.ok(pm.includes('SELECT post_type FROM wp_posts WHERE ID = NEW.post_id'));
	assert.ok(by('postmeta', 'DELETE').includes('OLD.post_id'));
	assert.ok(by('comments', 'INSERT').includes("'order_note'"));
	assert.ok(!by('terms', 'INSERT').includes(' IF '), 'terms bump on every write');
	for (const ty of ['shop_order', 'shop_order_placehold', 'shop_order_refund', 'shop_subscription']) assert.ok(ORDER_TYPES.includes(ty));
});

test('install is all or nothing; status and remove read state; a bad prefix is refused', async () => {
	const db = fakeDb();
	const r = await install(db.q, 'wp_');
	assert.equal(r.versioned, true);
	assert.equal(db.triggers.size, 21);
	assert.equal(db.v, 0);
	const s = await status(db.q, 'wp_');
	assert.equal(s.complete, true);
	assert.equal(s.version, 0);
	const gone = await remove(db.q, 'wp_');
	assert.equal(gone.ok, true);
	assert.equal(db.triggers.size, 0);
	assert.equal(db.tables.size, 0);
	const half = fakeDb({ refuseTrigger: (n) => n.endsWith('_comments_ai') });
	const h = await install(half.q, 'wp_');
	assert.equal(h.versioned, false);
	assert.match(h.reason, /comments_ai/);
	assert.equal(half.triggers.size, 0, 'a refused trigger removes every trigger');
	assert.equal(half.tables.size, 0, 'and the table');
	assert.equal((await install(db.q, 'wp_; DROP')).ok, false);
});

test('readPageVersion: a string or a binary cell; no table or no row is a failure, not version 0', async () => {
	for (const binary of [false, true]) {
		const db = fakeDb({ binary });
		await install(db.q, 'wp_');
		db.v = 41;
		assert.deepEqual(await readPageVersion(db.q, 'wp_'), { ok: true, v: '41' });
	}
	const none = fakeDb();
	assert.equal((await readPageVersion(none.q, 'wp_')).ok, false);
	const norow = fakeDb();
	await install(norow.q, 'wp_');
	norow.v = null;
	assert.equal((await readPageVersion(norow.q, 'wp_')).ok, false);
	assert.equal(cell(b64(7)), '7');
});

test('versionedUrl SETS the param (a client value is overwritten); stripPcv removes it', () => {
	assert.equal(new URL(versionedUrl('https://s.example/shop/?a=1', '5')).searchParams.get(PCV_PARAM), '5');
	const forged = versionedUrl(`https://s.example/?${PCV_PARAM}=999&b=2`, '5');
	assert.deepEqual(new URL(forged).searchParams.getAll(PCV_PARAM), ['5']);
	assert.equal(new URL(forged).searchParams.get('b'), '2');
	const req = stripPcv(new Request(forged, { headers: { 'x-a': '1' } }));
	assert.equal(new URL(req.url).searchParams.has(PCV_PARAM), false);
	assert.equal(new URL(req.url).searchParams.get('b'), '2');
	assert.equal(req.headers.get('x-a'), '1');
	assert.equal(stripPcv(new Request('https://s.example/x')).url, 'https://s.example/x');
});

test('pageVersionsOn: only with the flag, a one-shot DB handler, and not on the DO database', () => {
	const h = { oneShot: async () => ({}) };
	assert.equal(pageVersionsOn({ PAGE_CACHE_VERSIONS: 'on' }, h), true);
	assert.equal(pageVersionsOn({}, h), false, 'default off');
	assert.equal(pageVersionsOn({ PAGE_CACHE_VERSIONS: 'on' }, null), false, 'no DB handler (b-do, b-dosql)');
	assert.equal(pageVersionsOn({ PAGE_CACHE_VERSIONS: 'on' }, { query() {} }), false, 'no one-shot (mysql2 entry)');
	assert.equal(pageVersionsOn({ PAGE_CACHE_VERSIONS: 'on', DB_IN_DO: 'on' }, h), false);
});

// The property: two isolates share one edge cache (keyed on URL) and one database. A write
// through either one is never served stale from the cache to the next request of either.
async function twoIsolates({ keyed }) {
	const db = fakeDb();
	await install(db.q, 'wp_');
	let stock = 'in stock';
	const edge = new Map();
	const write = (v) => { stock = v; db.v += 1; }; // the trigger: same statement as the write
	async function get(path) {
		let url = `https://s.example${path}`;
		if (keyed) {
			const r = await readPageVersion(db.q, 'wp_');
			if (!r.ok) return { body: stock, cached: false };
			url = versionedUrl(url, r.v);
		}
		if (edge.has(url)) return { body: edge.get(url), cached: true };
		edge.set(url, stock);
		return { body: stock, cached: false };
	}
	return { get, write, db };
}

test('two isolates: a write in one is never served stale to the next request (and the key is what does it)', async () => {
	const s = await twoIsolates({ keyed: true });
	assert.equal((await s.get('/product/x/')).body, 'in stock');
	assert.equal((await s.get('/product/x/')).cached, true, 'a repeat is a hit');
	s.write('out of stock');
	const after = await s.get('/product/x/');
	assert.equal(after.body, 'out of stock');
	assert.equal(after.cached, false);
	assert.equal((await s.get('/product/x/')).cached, true, 'and is cached again under the new key');
	// Control: the same flow without the version in the key serves the stale page.
	const c = await twoIsolates({ keyed: false });
	await c.get('/product/x/');
	c.write('out of stock');
	assert.equal((await c.get('/product/x/')).body, 'in stock', 'the control must go stale, or this test cannot fail');
});

test('a failed counter read is served uncached, never from an old key', async () => {
	const s = await twoIsolates({ keyed: true });
	await s.get('/');
	await remove(s.db.q, 'wp_');
	const r = await s.get('/');
	assert.equal(r.cached, false);
});
