// cache-versions.mjs (#296 slice 1): the versions table and its triggers, all or nothing, against a
// fake MySQL that keeps the schema state, so install, status and remove are checked as state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install, status, remove, triggerSql, triggerNames, versionsTable, validPrefix, cell } from '../cache-versions.mjs';

const b64 = (s) => ({ $b: Buffer.from(String(s)).toString('base64') });
function fakeDb({ refuseTrigger = null, binary = false } = {}) {
	const db = { tables: new Set(), rows: new Map(), triggers: new Set(), log: [] };
	db.q = async (sql) => {
		db.log.push(sql);
		let m;
		if ((m = sql.match(/^CREATE TABLE IF NOT EXISTS (\w+)/))) { db.tables.add(m[1]); return { ok: true, affected: 0 }; }
		if ((m = sql.match(/^INSERT IGNORE INTO (\w+) \(grp, v\) VALUES (.*)$/))) { for (const g of m[2].matchAll(/\('(\w+)', 0\)/g)) if (!db.rows.has(g[1])) db.rows.set(g[1], 0); return { ok: true }; }
		if ((m = sql.match(/^DROP TRIGGER IF EXISTS (\w+)$/))) { db.triggers.delete(m[1]); return { ok: true }; }
		if ((m = sql.match(/^CREATE TRIGGER (\w+) AFTER (INSERT|UPDATE|DELETE) ON (\w+) FOR EACH ROW /))) {
			if (refuseTrigger && refuseTrigger(m[1])) return { ok: false, errno: 1235, error: 'This version of MySQL does not yet support triggers' };
			db.triggers.add(m[1]); return { ok: true };
		}
		if ((m = sql.match(/^DROP TABLE IF EXISTS (\w+)$/))) { db.tables.delete(m[1]); db.rows.clear(); return { ok: true }; }
		if ((m = sql.match(/information_schema\.tables .* table_name = '(\w+)'/))) return { ok: true, rows: [[binary ? b64(db.tables.has(m[1]) ? 1 : 0) : (db.tables.has(m[1]) ? '1' : '0')]] };
		if (/information_schema\.triggers/.test(sql)) return { ok: true, rows: [...db.triggers].map((t) => [t]) };
		if ((m = sql.match(/^SELECT grp, v FROM (\w+)$/))) return db.tables.has(m[1]) ? { ok: true, rows: [...db.rows].map(([g, v]) => [g, binary ? b64(v) : String(v)]) } : { ok: false, errno: 1146, error: 'no table' };
		return { ok: false, error: 'fake: unexpected SQL ' + sql.slice(0, 60) };
	};
	return db;
}

test('install makes the versions table, its three rows and all nine triggers', async () => {
	const db = fakeDb();
	const r = await install(db.q, 'wp_');
	assert.equal(r.ok, true); assert.equal(r.versioned, true);
	assert.deepEqual([...db.tables], ['wp_skyph_cache_versions']);
	assert.deepEqual(Object.fromEntries(db.rows), { posts: 0, post_meta: 0, options: 0 });
	assert.deepEqual([...db.triggers].sort(), triggerNames('wp_').sort());
	assert.equal(r.status.complete, true);
});
test('install twice is idempotent (the rows keep their versions)', async () => {
	const db = fakeDb();
	await install(db.q, 'wp_'); db.rows.set('posts', 7);
	const r = await install(db.q, 'wp_');
	assert.equal(r.versioned, true); assert.equal(db.rows.get('posts'), 7); assert.equal(db.triggers.size, 9);
});
test('CAPABILITY: a provider that refuses a trigger is left unversioned, with NOTHING behind', async () => {
	const db = fakeDb({ refuseTrigger: (n) => n === 'wp_skyph_v_postmeta_au' });
	const r = await install(db.q, 'wp_');
	assert.equal(r.ok, true); assert.equal(r.versioned, false);
	assert.match(r.reason, /wp_skyph_v_postmeta_au: 1235/);
	assert.equal(db.tables.size, 0, 'no versions table, so the cache keeps its unversioned posture');
	assert.equal(db.triggers.size, 0, 'the triggers made before the refusal are dropped again');
	assert.equal(r.removed, true);
});
test('remove drops every trigger and the table, and reads back clean', async () => {
	const db = fakeDb();
	await install(db.q, 'wp_');
	const r = await remove(db.q, 'wp_');
	assert.equal(r.ok, true); assert.equal(r.after.table, false); assert.deepEqual(r.after.triggers, []);
	assert.equal(db.tables.size + db.triggers.size, 0);
});
test('status before install: no table, no triggers, not complete', async () => {
	const s = await status(fakeDb().q, 'wp_');
	assert.deepEqual({ ok: s.ok, table: s.table, triggers: s.triggers, complete: s.complete }, { ok: true, table: false, triggers: [], complete: false });
});
test('the triggers: one per table and event, bumping the right group; options skip transients', () => {
	const t = triggerSql('wp_');
	assert.equal(t.length, 9);
	for (const x of t) assert.ok(!/;\s*\S/.test(x.sql.replace(/BEGIN.*END$/, '')), 'one statement each (Hyperdrive refuses multi-statement SQL)');
	assert.match(t.find((x) => x.name === 'wp_skyph_v_posts_au').sql, /^CREATE TRIGGER wp_skyph_v_posts_au AFTER UPDATE ON wp_posts FOR EACH ROW UPDATE wp_skyph_cache_versions SET v = v \+ 1 WHERE grp = 'posts'$/);
	assert.match(t.find((x) => x.name === 'wp_skyph_v_postmeta_ai').sql, /ON wp_postmeta .* grp = 'post_meta'/);
	const od = t.find((x) => x.name === 'wp_skyph_v_options_ad').sql;
	assert.match(od, /OLD\.option_name NOT LIKE '\\_transient\\_%' AND OLD\.option_name NOT LIKE '\\_site\\_transient\\_%' THEN UPDATE wp_skyph_cache_versions SET v = v \+ 1 WHERE grp = 'options'; END IF; END$/);
	assert.match(t.find((x) => x.name === 'wp_skyph_v_options_ai').sql, /NEW\.option_name NOT LIKE/);
});
test('THE LIVE CASE: binary-charset cells ({ $b: base64 }, COUNT(*) and the BIGINT) are decoded', async () => {
	assert.equal(cell(b64(1)), '1'); assert.equal(cell('x'), 'x'); assert.equal(cell(null), null);
	const db = fakeDb({ binary: true });
	const r = await install(db.q, 'wp_');
	assert.equal(r.versioned, true, 'the table is seen, so the install is complete');
	db.rows.set('posts', 4);
	const s = await status(db.q, 'wp_');
	assert.equal(s.table, true); assert.deepEqual(s.versions, { posts: 4, post_meta: 0, options: 0 });
});
test('the table prefix is validated before any SQL', async () => {
	assert.equal(validPrefix('wp_'), true); assert.equal(validPrefix("wp_'; DROP"), false); assert.equal(validPrefix(''), false);
	const db = fakeDb();
	assert.equal((await install(db.q, 'x; --')).ok, false); assert.equal(db.log.length, 0);
	assert.equal(versionsTable('shop_'), 'shop_skyph_cache_versions');
});
