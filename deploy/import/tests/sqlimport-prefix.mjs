// #487: /_sqlimport keeps to the site's own WP_TABLE_PREFIX on a database that several stores share.
//   node sqlimport-prefix.mjs <.mjs copy of sql-import.js>
// A fake MySQL with two installations, wp_ and wp_ggc_ (each has options and posts), and the rows of
// each table. Each guard has a check that goes red when the guard is removed (see the PR).
const { sqlImport } = await import(process.argv[2]);
let fails = 0;
const check = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) fails++;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
function sharedDb() {
	const tables = new Map([['wp_options', 3], ['wp_posts', 5], ['wp_users', 1], ['wp_ggc_options', 7], ['wp_ggc_posts', 11], ['wp_ggc_users', 2]]);
	const ran = [];
	return {
		ran, tables,
		async query(env, m) {
			const sql = m.mysql;
			ran.push(sql);
			let x;
			if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('SET SESSION')) return { ok: true };
			if (sql === 'SELECT VERSION()') return { ok: true, rows: [['10.11.6-MariaDB']] };
			if (sql === 'SELECT @@max_allowed_packet') return { ok: true, rows: [['16777216']] };
			if (sql === 'SELECT @@SESSION.sql_mode') return { ok: true, rows: [['STRICT_TRANS_TABLES']] };
			if (sql === 'SHOW TABLES') return { ok: true, rows: [...tables.keys()].map((t) => [t]) };
			if ((x = sql.match(/^SELECT COUNT\(\*\) FROM `([^`]+)`$/))) return { ok: true, rows: [[String(tables.get(x[1]))]] };
			if (sql.startsWith('SHOW COLUMNS')) return { ok: true, rows: [] };
			if ((x = sql.match(/^DROP TABLE IF EXISTS `([^`]+)`$/))) return tables.delete(x[1]), { ok: true };
			if ((x = sql.match(/^CREATE TABLE `([^`]+)`/))) return tables.set(x[1], 0), { ok: true };
			if ((x = sql.match(/INTO `([^`]+)` VALUES (.*)$/))) return tables.set(x[1], (tables.get(x[1]) || 0) + x[2].split('),(').length), { ok: true };
			return { ok: true };
		},
	};
}
const envFor = (prefix) => ({ SPIKE_TOKEN: 't', PHP_ENV: JSON.stringify({ USE_ZEND_ALLOC: '0', ...(prefix === undefined ? {} : { WP_TABLE_PREFIX: prefix }) }) });
const call = async (db, method, path, body, env) => {
	const r = await sqlImport(new Request('https://x.example' + path, { method, body, headers: { 'x-spike-token': 't' } }), env, new URL('https://x.example' + path), db);
	let o = null;
	try { o = await r.json(); } catch {}
	return { status: r.status, o };
};
const line = (sql) => JSON.stringify({ sql }) + '\n';
const ggcRows = (db) => ['wp_ggc_options', 'wp_ggc_posts', 'wp_ggc_users'].map((t) => db.tables.get(t));

// replace into wp_ (the default prefix) on a shared database
let db = sharedDb();
let r = await call(db, 'POST', '/_sqlimport?replace=1', line('DROP TABLE IF EXISTS `wp_options`') + line('CREATE TABLE `wp_options` (`a` int)') + line('INSERT INTO `wp_options` VALUES (1),(2)'), envFor(undefined));
check('replace into wp_: ok', [r.status, r.o.ok], [200, true]);
check('replace into wp_: drops only wp_ tables (wp_options, wp_posts, wp_users)', db.ran.filter((x) => x.startsWith('DROP')).slice(0, 3), ['DROP TABLE IF EXISTS `wp_options`', 'DROP TABLE IF EXISTS `wp_posts`', 'DROP TABLE IF EXISTS `wp_users`']);
check('replace into wp_: the other store (wp_ggc_) keeps every table and row', ggcRows(db), [7, 11, 2]);
check('replace into wp_: dropped counts only its own', r.o.dropped, 3);

// replace into wp_ggc_ leaves wp_ alone
db = sharedDb();
r = await call(db, 'POST', '/_sqlimport?replace=1', line('CREATE TABLE `wp_ggc_options` (`a` int)'), envFor('wp_ggc_'));
check('replace into wp_ggc_: ok', [r.status, r.o.ok, r.o.dropped], [200, true, 3]);
check('replace into wp_ggc_: wp_ keeps every table and row', ['wp_options', 'wp_posts', 'wp_users'].map((t) => db.tables.get(t)), [3, 5, 1]);

// counts sees only its own
r = await call(sharedDb(), 'GET', '/_sqlimport?counts=1', undefined, envFor('wp_'));
check('counts (wp_): only wp_ tables, not wp_ggc_', Object.keys(r.o.tables), ['wp_options', 'wp_posts', 'wp_users']);
r = await call(sharedDb(), 'GET', '/_sqlimport?counts=1', undefined, envFor('wp_ggc_'));
check('counts (wp_ggc_): only its own', Object.keys(r.o.tables), ['wp_ggc_options', 'wp_ggc_posts', 'wp_ggc_users']);

// a dump with a foreign table is refused, nothing dropped
db = sharedDb();
r = await call(db, 'POST', '/_sqlimport?replace=1', line('CREATE TABLE `wp_options` (`a` int)') + line('INSERT INTO `wp_ggc_options` VALUES (9)'), envFor('wp_'));
check('a foreign-prefix table in the dump (wp_ggc_ into wp_): 400 at its line', [r.status, r.o.line], [400, 2]);
check('  nothing dropped or written: only SHOW TABLES ran', db.ran, ['SHOW TABLES']);
db = sharedDb();
r = await call(db, 'POST', '/_sqlimport?replace=1', line('DROP TABLE IF EXISTS `wp_options`'), envFor('wp_ggc_'));
check('a table outside the prefix (wp_options into wp_ggc_): 400 before any database call', [r.status, db.ran], [400, []]);

// the prefix is the site's, and a bad one refuses everything
r = await call(sharedDb(), 'GET', '/_sqlimport?info=1', undefined, envFor('wp_ggc_'));
check('info reports the site prefix', r.o.prefix, 'wp_ggc_');
db = sharedDb();
r = await call(db, 'POST', '/_sqlimport?replace=1', line('DROP TABLE IF EXISTS `wp_options`'), envFor('wp-bad;'));
check('a bad WP_TABLE_PREFIX: 500, nothing ran', [r.status, db.ran.length], [500, 0]);
db = sharedDb();
r = await call(db, 'POST', '/_sqlimport?replace=1', line('DROP TABLE IF EXISTS `wp_options`'), { SPIKE_TOKEN: 't', PHP_ENV: 'not json' });
check('PHP_ENV not JSON: 500, nothing ran', [r.status, db.ran.length], [500, 0]);

// preflight scratch tables carry the prefix
db = sharedDb();
r = await call(db, 'POST', '/_sqlimport?preflight=1', line('CREATE TABLE `wp_ggc_options` (`a` int)'), envFor('wp_ggc_'));
check('preflight scratch name is <prefix>impchk_<n>', [r.status, db.ran.filter((x) => x.startsWith('CREATE')).map((x) => x.slice(0, 35))], [200, ['CREATE TABLE `wp_ggc_impchk_0` (`a`']]);
check('  preflight leaves both stores as they were', [ggcRows(db), db.tables.get('wp_options')], [[7, 11, 2], 3]);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
