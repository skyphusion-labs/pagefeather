import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { exportPage, exportStats, exportTables, exportRequest, EXPORT_MAX_LIMIT } from '../mysql-export.mjs';

// A real SQLite, with the shapes the driver makes: STRICT rowid tables, an integer primary key,
// a composite primary key, NULLs, a blob, and the driver's own and the platform's tables to skip.
function db() {
	const d = new DatabaseSync(':memory:');
	d.exec(`CREATE TABLE wp_posts (ID INTEGER PRIMARY KEY AUTOINCREMENT, post_title TEXT, post_content TEXT) STRICT;
		CREATE TABLE wp_term_relationships (object_id INTEGER NOT NULL, term_taxonomy_id INTEGER NOT NULL, term_order INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (object_id, term_taxonomy_id)) STRICT;
		CREATE TABLE wp_blobby (id INTEGER PRIMARY KEY, b BLOB) STRICT;
		CREATE TABLE _cf_KV (k TEXT PRIMARY KEY, v BLOB);
		CREATE TABLE _wp_undo_log (id INTEGER PRIMARY KEY);
		CREATE TABLE "_wp_sqlite_global_variables" (name TEXT PRIMARY KEY, value TEXT);`);
	const ins = d.prepare('INSERT INTO wp_posts (post_title, post_content) VALUES (?, ?)');
	for (let i = 1; i <= 1234; i++) ins.run(`t${i}`, i % 7 ? `c${i}` : null);
	d.exec('DELETE FROM wp_posts WHERE ID % 100 = 0'); // gaps, as a real table has
	const tr = d.prepare('INSERT INTO wp_term_relationships VALUES (?, ?, ?)');
	for (let o = 1; o <= 40; o++) for (let t = 1; t <= 3; t++) tr.run(o, t, 0);
	d.prepare('INSERT INTO wp_blobby VALUES (?, ?)').run(1, new Uint8Array([0, 255, 1, 2]));
	return d;
}
const adapter = (d) => (sql, ...b) => {
	const st = d.prepare(sql);
	const cols = st.columns().map((c) => c.name);
	st.setReadBigInts(false);
	return { columns: cols, rows: st.all(...b).map((o) => cols.map((c) => o[c])) };
};
// node:sqlite returns objects by column name; a duplicate column name would be lost, so the
// adapter above needs unique names, which "__rowid" keeps.

test('the export lists user tables only: never sqlite_, _cf_ or _wp_undo; the driver metadata is included', () => {
	const t = exportTables(adapter(db()));
	assert.deepEqual(t, ['_wp_sqlite_global_variables', 'wp_blobby', 'wp_posts', 'wp_term_relationships']);
});

test('paging by rowid returns every row exactly once, with gaps and a composite primary key', () => {
	const q = adapter(db());
	const stats = exportStats(q).tables;
	for (const table of ['wp_posts', 'wp_term_relationships']) {
		const seen = [];
		let after = 0, pages = 0, last = 0;
		for (;;) {
			const p = exportPage(q, { table, after, limit: 97 });
			pages++;
			seen.push(...p.rows);
			last = p.last;
			if (p.done) break;
			after = p.last;
		}
		assert.equal(seen.length, stats[table].rows, `${table}: rows add up to COUNT(*)`);
		assert.equal(last, stats[table].maxRowid, `${table}: the last rowid reaches MAX(rowid)`);
		assert.equal(new Set(seen.map((r) => JSON.stringify(r))).size, seen.length, `${table}: no row twice`);
		assert.ok(pages > 1);
	}
	assert.equal(exportStats(q).tables.wp_posts.rows, 1222);
});

test('a page has the column names (no rowid), NULLs as null, and a blob as {$b}', () => {
	const q = adapter(db());
	const p = exportPage(q, { table: 'wp_posts', after: 0, limit: 10 });
	assert.deepEqual(p.columns, ['ID', 'post_title', 'post_content']);
	assert.equal(p.rows[6][2], null, 'row 7 has a NULL content');
	const b = exportPage(q, { table: 'wp_blobby' });
	assert.deepEqual(b.rows[0], [1, { $b: Buffer.from([0, 255, 1, 2]).toString('base64') }]);
});

test('refusals: an unknown or internal table, and a bad after or limit, are a 400 with nothing read', async () => {
	const q = adapter(db());
	for (const [qs, re] of [
		['table=wp_nope', /no such table/],
		['table=sqlite_master', /no such table/],
		['table=_cf_KV', /no such table/],
		['table=wp_posts%22%3B%20DROP%20TABLE%20wp_posts%3B--', /no such table/],
		['table=wp_posts&after=-1', /after must be a whole number/],
		['table=wp_posts&after=1e3', /after must be a whole number/],
		[`table=wp_posts&limit=${EXPORT_MAX_LIMIT + 1}`, /limit must be from 1 to/],
		['table=wp_posts&limit=0', /limit must be from 1 to/],
	]) {
		const res = exportRequest(q, new URL('https://x/_mysqlexport?' + qs));
		assert.equal(res.status, 400, qs);
		assert.match((await res.json()).error, re, qs);
	}
	assert.equal(exportStats(q).tables.wp_posts.rows, 1222, 'nothing was dropped');
	const ok = exportRequest(q, new URL('https://x/_mysqlexport?stats=1'));
	assert.equal(ok.status, 200);
	assert.equal(ok.headers.get('cache-control'), 'private, no-store');
});

test('index.js serves /_mysqlexport only in the object, behind the spike-token gate, from raw SQL', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.ok(src.includes("import { exportRequest } from './mysql-export.mjs';"));
	const at = src.indexOf("if (url.pathname === '/_mysqlexport' && req.method === 'GET') {");
	assert.ok(at > 0, 'the route exists');
	const gate = src.lastIndexOf("if (url.pathname.startsWith('/_') && !spikeOk) return new Response('forbidden', { status: 403 });", at);
	assert.ok(gate > 0 && gate < at, 'the spike-token gate comes before the route');
	const body = src.slice(at, src.indexOf('}', src.indexOf('exportRequest(', at)) + 1);
	assert.ok(body.includes("if (!sql) return new Response('DB_IN_DO is off', { status: 409 });"));
	assert.ok(!/withPhp|handle\(/.test(body), 'no PHP boot for the export');
});
