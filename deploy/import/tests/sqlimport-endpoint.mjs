// sqlImport() of spikes/b2-wordpress/sql-import.js against a fake database
// (issue #31). It tests the endpoint's rules, not MySQL.
//   node sqlimport-endpoint.mjs <.mjs copy of sql-import.js>
const { sqlImport } = await import(process.argv[2]);
let fails = 0;
const check = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) fails++;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const b64 = (t) => ({ $b: Buffer.from(t).toString('base64') });
function fakeDb({ vitess = false, packet = 16777216, binary = false, garbage = false } = {}) {
	const ran = [];
	const tables = ['wp_options', 'wp_posts', 'other_plugin_table'];
	// Strict like PlanetScale through Hyperdrive: a SET holds only inside a
	// transaction; a zero-date DEFAULT needs the relaxed mode.
	let inTx = false;
	let mode = null;
	return {
		ran,
		async query(env, m) {
			const sql = m.mysql;
			ran.push(sql);
			if (sql === 'BEGIN') return (inTx = true), { ok: true };
			if (sql === 'COMMIT') return (inTx = false), (mode = null), { ok: true };
			if (sql.startsWith('SET SESSION sql_mode')) return (mode = inTx ? sql : null), { ok: true };
			const relaxed = inTx && mode === "SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO'";
			if (!inTx) mode = null;
			if (sql.startsWith('CREATE TABLE') && sql.includes("'0000-00-00") && !relaxed) return { ok: false, error: "Invalid default value for 'scheduled_date_gmt'", errno: 1067 };
			if (sql.startsWith('CREATE TABLE') && sql.includes('FAILDDL')) return { ok: false, error: 'refused ddl', errno: 1064 };
			if (sql === 'SELECT VERSION()') return { ok: true, rows: [[vitess ? '8.0.34-PlanetScale' : '10.11.6-MariaDB-0+deb12u1']] };
			if (sql === 'SELECT @@max_allowed_packet') return { ok: true, rows: vitess ? [] : [[binary ? b64(String(packet)) : String(packet)]] };
			if (sql.startsWith('SHOW VARIABLES')) return { ok: true, rows: packet ? [['max_allowed_packet', String(packet)]] : [] };
			if (sql === 'SHOW TABLES') return { ok: true, rows: tables.map((t) => [t]) };
			// binary: as mysql-bridge.js returns a binary-charset column (MariaDB COUNT(*)).
			if (sql.startsWith('SELECT COUNT(*)')) return { ok: true, rows: [[garbage ? { other: 1 } : binary ? b64('3') : '3']] };
			if (sql.startsWith('SHOW COLUMNS')) return { ok: true, rows: [['ID']] };
			if (sql.startsWith('SELECT MIN(')) return { ok: true, rows: [[binary ? b64('0') : '0']] };
			if (sql.includes('FAILME')) return { ok: false, error: 'boom', errno: 1064 };
			return { ok: true, affected: 1 };
		},
	};
}
const env = { SPIKE_TOKEN: 't' };
const req = (method, path, body, token = 't') => new Request('https://x.example' + path, { method, body, headers: token === null ? {} : { 'x-spike-token': token } });
const call = async (db, method, path, body, token, e = env) => {
	const r = await sqlImport(req(method, path, body, token), e, new URL('https://x.example' + path), db);
	let o = null;
	try {
		o = await r.json();
	} catch {}
	return { status: r.status, o };
};
const line = (sql) => JSON.stringify({ sql }) + '\n';

let db = fakeDb();
check('no db handler (not variant a): 404', (await call(null, 'GET', '/_sqlimport?info=1')).status, 404);
check('wrong token: 403', (await call(db, 'GET', '/_sqlimport?info=1', undefined, 'x')).status, 403);
check('no SPIKE_TOKEN secret: 403', (await call(db, 'GET', '/_sqlimport?info=1', undefined, 't', {})).status, 403);
check('no header: 403', (await call(db, 'GET', '/_sqlimport?info=1', undefined, null)).status, 403);
check('nothing ran for refused requests', db.ran.length, 0);
let r = await call(db, 'GET', '/_sqlimport?info=1');
check('info on MariaDB', [r.o.flavour, r.o.max_allowed_packet, r.o.packet_via], ['mariadb', 16777216, 'SELECT @@max_allowed_packet']);
r = await call(fakeDb({ vitess: true, packet: 67108864 }), 'GET', '/_sqlimport?info=1');
check('info on PlanetScale: packet from SHOW VARIABLES', [r.o.flavour, r.o.max_allowed_packet, r.o.packet_via], ['mysql', 67108864, 'SHOW VARIABLES']);
r = await call(fakeDb({ vitess: true, packet: 0 }), 'GET', '/_sqlimport?info=1');
check('info with no packet value: null, not a guess', r.o.max_allowed_packet, null);
db = fakeDb();
r = await call(db, 'POST', '/_sqlimport?replace=1', line('DROP TABLE IF EXISTS `wp_a`') + line("GRANT ALL ON *.* TO `x`"));
check('one refused line: 400 at that line', [r.status, r.o.line], [400, 2]);
check('one refused line: nothing ran, not even the drop of replace', db.ran.length, 0);
db = fakeDb();
r = await call(db, 'POST', '/_sqlimport?replace=1', line('DROP TABLE IF EXISTS `wp_a`') + line("INSERT INTO `wp_a` VALUES (1,'x')"));
check('replace drops the wp_ tables only, then runs the lines', db.ran, ['SHOW TABLES', 'DROP TABLE IF EXISTS `wp_options`', 'DROP TABLE IF EXISTS `wp_posts`', 'DROP TABLE IF EXISTS `wp_a`', "INSERT INTO `wp_a` VALUES (1,'x')"]);
check('replace result', [r.status, r.o.ok, r.o.statements, r.o.dropped], [200, true, 2, 2]);
db = fakeDb();
r = await call(db, 'POST', '/_sqlimport', line("INSERT INTO `wp_a` VALUES (1,'ok')") + line("INSERT INTO `wp_a` VALUES (2,'FAILME')") + line("INSERT INTO `wp_a` VALUES (3,'never')"));
check('a failing statement stops: line, ran', [r.status, r.o.line, r.o.ran, db.ran.length], [400, 2, 1, 2]);
r = await call(fakeDb(), 'GET', '/_sqlimport?counts=1');
check('counts: wp_ tables only', Object.keys(r.o.tables), ['wp_options', 'wp_posts']);
check('counts: rows and min_pk', r.o.tables.wp_options, { rows: 3, min_pk: 0 });
r = await call(fakeDb({ binary: true }), 'GET', '/_sqlimport?counts=1');
check('counts: binary cells (MariaDB) decoded', r.o.tables.wp_options, { rows: 3, min_pk: 0 });
r = await call(fakeDb({ binary: true }), 'GET', '/_sqlimport?info=1');
check('info: binary packet cell decoded', r.o.max_allowed_packet, 16777216);
r = await call(fakeDb({ garbage: true }), 'GET', '/_sqlimport?counts=1');
check('counts: a count that is not an integer is a 500, not a null', [r.status, r.o.ok, /COUNT\(\*\) of wp_options: not an integer/.test(r.o.error)], [500, false, true]);
const zero = "CREATE TABLE `wp_actionscheduler_actions` (`id` bigint NOT NULL, `scheduled_date_gmt` datetime DEFAULT '0000-00-00 00:00:00')";
db = fakeDb();
r = await call(db, 'POST', '/_sqlimport', line('DROP TABLE IF EXISTS `wp_actionscheduler_actions`') + line(zero));
check('zero-date CREATE runs in the DDL mode on a strict server', [r.status, r.o.ok], [200, true]);
check('the DDL mode: BEGIN, SET SESSION, CREATE, COMMIT', db.ran.slice(1), ['BEGIN', "SET SESSION sql_mode='NO_AUTO_VALUE_ON_ZERO'", zero, 'COMMIT']);
db = fakeDb();
r = await call(db, 'POST', '/_sqlimport?preflight=1', line(zero) + line(zero.replace('wp_actionscheduler_actions', 'wp_two')));
check('preflight: each CREATE under a scratch name, then dropped', [r.status, r.o.preflight, db.ran.filter((x) => /^(DROP|CREATE)/.test(x)).map((x) => x.slice(0, 33))], [200, 2, ['DROP TABLE IF EXISTS `wp_impchk_0', 'CREATE TABLE `wp_impchk_0` (`id` ', 'DROP TABLE IF EXISTS `wp_impchk_0', 'DROP TABLE IF EXISTS `wp_impchk_1', 'CREATE TABLE `wp_impchk_1` (`id` ', 'DROP TABLE IF EXISTS `wp_impchk_1']]);
check('preflight never touches a real table', db.ran.some((x) => /wp_actionscheduler_actions|wp_two|SHOW TABLES/.test(x)), false);
db = fakeDb();
r = await call(db, 'POST', '/_sqlimport?preflight=1', line(zero) + line('CREATE TABLE `wp_bad` (`a` int) COMMENT=\'FAILDDL\''));
check('preflight: a refused CREATE is a 400 at its line, scratch dropped', [r.status, r.o.line, r.o.preflight, db.ran[db.ran.length - 1]], [400, 2, true, 'DROP TABLE IF EXISTS `wp_impchk_1`']);
r = await call(fakeDb(), 'POST', '/_sqlimport?preflight=1', line("INSERT INTO `wp_a` VALUES (1)"));
check('preflight takes CREATE TABLE only', [r.status, r.o.error], [400, 'preflight takes CREATE TABLE only']);
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
