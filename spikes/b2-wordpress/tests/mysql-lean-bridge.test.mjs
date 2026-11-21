// node --import ./spikes/b2-wordpress/tests/fixtures/lean/register.mjs --test spikes/b2-wordpress/tests/mysql-lean-bridge.test.mjs
// #1101: approach A deploys the LEAN client by default (deploy/a-settings.sh a_main: index-a-lean.js, mysql-lean-bridge.js).
// #1102 fixed mysql-bridge.js (mysql2, only with A_CLIENT=mysql2), so the default path kept both defects:
//   - mysqlEnd awaited LeanMysql.end() unbounded, and end() awaits a COM_QUIT write and socket.close(), which never settle on
//     a dead socket: the post-response ctx.waitUntil(end()) hung (cf759hx, both hung add-to-carts);
//   - a rejected connect was cached and failed every later statement of the run (x-sql-failure 17).
// mysqlOneShot (the page-version read, the idle cron gate, the upload sweep) awaited its connect and end() unbounded too.
// The bridge now uses connector.mjs (retry once; connect bounded 3 s, end 2 s; destroy on timeout), and LeanMysql gains
// destroy(): it closes the socket without awaiting anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeanMysql as RealLean } from '../mysql-lean.js';

const lean = (globalThis.__lean ??= { connect: null });
const bridge = await import('../mysql-lean-bridge.js?fake');
const ENV = { HYPERDRIVE: { host: 'h', user: 'u', password: 'p', database: 'd', port: 3306 } };
const never = () => new Promise(() => {});
const okConn = (extra = {}) => ({ query: async () => ({ kind: 'ok', affectedRows: 1, insertId: 0 }), end: async () => {}, destroy: () => {}, ...extra });

test('LeanMysql.destroy() closes the socket at once, even when a write would never settle', () => {
	let closed = 0;
	const socket = { writable: { getWriter: () => ({ write: never, releaseLock: () => {} }) }, readable: { getReader: () => ({ read: never, releaseLock: () => {} }) }, close: () => { closed++; return never(); } };
	const c = new RealLean(socket);
	const t0 = Date.now();
	c.destroy();
	assert.ok(Date.now() - t0 < 50, 'synchronous: nothing awaited');
	assert.equal(closed, 1);
	assert.equal(c.closed, true);
	c.destroy();
	assert.equal(closed, 1, 'once');
});
test('RED-then-GREEN: mysqlEnd on a connection whose end() never settles returns within the bound and destroys it', async () => {
	let destroyed = 0;
	lean.connect = async () => okConn({ end: never, destroy: () => { destroyed++; } });
	bridge.mysqlReset();
	assert.equal((await bridge.mysqlQuery(ENV, { mysql: 'UPDATE t SET a = 1' })).ok, true);
	const t0 = Date.now();
	await bridge.mysqlEnd();
	assert.ok(Date.now() - t0 < 3500, 'bounded (END_MS 2 s), not hung: ' + (Date.now() - t0) + ' ms');
	assert.equal(destroyed, 1);
});
test('a transient connect failure is retried once, and the run proceeds (not 17 failed statements)', async () => {
	let calls = 0;
	lean.connect = async () => { calls++; if (calls === 1) throw new Error('Network connection lost.'); return okConn(); };
	bridge.mysqlReset();
	for (let i = 0; i < 17; i++) assert.equal((await bridge.mysqlQuery(ENV, { mysql: 'SELECT 1' })).ok, true);
	assert.equal(calls, 2);
	await bridge.mysqlEnd();
});
test('mysqlOneShot is bounded: an end() that never settles still returns its answer within the bound', async () => {
	lean.connect = async () => okConn({ end: never });
	const t0 = Date.now();
	const r = await bridge.mysqlOneShot(ENV, 'SELECT 1');
	assert.equal(r.ok, true);
	assert.ok(Date.now() - t0 < 3500, 'bounded: ' + (Date.now() - t0) + ' ms');
});
test('mysqlOneShot: a connect that never settles answers ok:false within the connect bound (two attempts)', async () => {
	lean.connect = never;
	const t0 = Date.now();
	const r = await bridge.mysqlOneShot(ENV, 'SELECT 1');
	assert.equal(r.ok, false);
	assert.match(r.error, /connect timed out/);
	assert.ok(Date.now() - t0 < 8000, 'two bounded attempts: ' + (Date.now() - t0) + ' ms');
});

// The lead's guard against #1101's miss (#1102 fixed the mysql2 bridge, which the default deploy does not load). The DEFAULT
// approach A path is pinned end to end, so a fix in the unused bridge, or a switch of the default, goes red here:
// deploy/a-settings.sh a_main -> index-a-lean.js (unless A_CLIENT=mysql2) -> mysql-lean-bridge.js -> connector.mjs.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
test('DEFAULT PATH: a_main renders index-a-lean.js unless A_CLIENT=mysql2', () => {
	const root = new URL('../../../', import.meta.url).pathname;
	const run = (env) => execFileSync('bash', ['-c', '. deploy/a-settings.sh && a_main'], { cwd: root, env: { PATH: process.env.PATH, ...env } }).toString().trim();
	assert.equal(run({}), 'index-a-lean.js', 'the default');
	assert.equal(run({ A_CLIENT: 'lean' }), 'index-a-lean.js');
	assert.equal(run({ A_CLIENT: 'mysql2' }), 'index-a.js', 'mysql2 only when asked');
});
test('DEFAULT PATH: index-a-lean.js registers mysql-lean-bridge.js, which uses connector.mjs (the #1101 fix is on the loaded bridge)', () => {
	const entry = readFileSync(new URL('../index-a-lean.js', import.meta.url), 'utf8');
	assert.match(entry, /from '\.\/mysql-lean-bridge\.js';/);
	assert.match(entry, /setDbHandler\(\{ query: mysqlQuery, end: mysqlEnd, reset: mysqlReset, oneShot: mysqlOneShot \}\);/);
	assert.doesNotMatch(entry, /mysql-bridge\.js/, 'not the mysql2 bridge');
	const bridge = readFileSync(new URL('../mysql-lean-bridge.js', import.meta.url), 'utf8');
	assert.match(bridge, /import \{ createConnector \} from '\.\/connector\.mjs';/);
	assert.match(bridge, /const connector = createConnector\(/);
	assert.match(bridge, /const one = createConnector\(openLean\(env\), \{ log \}\);/, 'oneShot is bounded too');
	assert.match(bridge, /export async function mysqlEnd\(\) \{\n(\t((inTx|lostInTx) = false|tempTables\.clear\(\));\n)*\tawait connector\.end\(\);\n\}/); // #1178: the run's transaction state is cleared first
});

// #1101 arm 4 instruments (strummer, the lead): the counts of connect-timeout and db-end-timeout mean something only if a
// bounded connect or end() through THIS bridge is logged. Positive controls: each bound, hit through the lean bridge,
// prints its event line on console.log (the Workers Logs channel); a healthy run prints none.
async function eventsDuring(fn) {
	const lines = [];
	const orig = console.log;
	console.log = (...a) => { lines.push(a.join(' ')); };
	try { await fn(); } finally { console.log = orig; }
	return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((o) => o && o.m);
}
const named = (ev, m) => ev.filter((o) => o.m === m && o['@event'] === m);
test('EVENT: a run connect that never settles logs connect-timeout for each of its two attempts', async () => {
	lean.connect = never;
	bridge.mysqlReset();
	const ev = await eventsDuring(async () => { assert.equal((await bridge.mysqlQuery(ENV, { mysql: 'SELECT 1' })).ok, false); });
	assert.deepEqual(named(ev, 'connect-timeout').map((o) => o.attempt), [1, 2], JSON.stringify(ev));
	await bridge.mysqlEnd();
});
test('EVENT: a run end() that never settles logs db-end-timeout after end', async () => {
	lean.connect = async () => okConn({ end: never });
	bridge.mysqlReset();
	assert.equal((await bridge.mysqlQuery(ENV, { mysql: 'SELECT 1' })).ok, true);
	const ev = await eventsDuring(() => bridge.mysqlEnd());
	assert.deepEqual(named(ev, 'db-end-timeout').map((o) => o.after), ['end'], JSON.stringify(ev));
});
test('EVENT: an end() while the connect is still pending logs db-end-timeout after pending-connect', async () => {
	lean.connect = never;
	bridge.mysqlReset();
	const ev = await eventsDuring(async () => {
		const q = bridge.mysqlQuery(ENV, { mysql: 'SELECT 1' });
		await new Promise((r) => setTimeout(r, 50));
		await bridge.mysqlEnd();
		await q;
	});
	assert.ok(named(ev, 'db-end-timeout').some((o) => o.after === 'pending-connect'), JSON.stringify(ev));
});
test('EVENT: mysqlOneShot logs connect-timeout through its own connector too', async () => {
	lean.connect = never;
	const ev = await eventsDuring(async () => { assert.equal((await bridge.mysqlOneShot(ENV, 'SELECT 1')).ok, false); });
	assert.deepEqual(named(ev, 'connect-timeout').map((o) => o.attempt), [1, 2], JSON.stringify(ev));
});
test('EVENT: a healthy run logs neither event (so a zero count is a real zero)', async () => {
	lean.connect = async () => okConn();
	bridge.mysqlReset();
	const ev = await eventsDuring(async () => {
		for (let i = 0; i < 3; i++) assert.equal((await bridge.mysqlQuery(ENV, { mysql: 'SELECT 1' })).ok, true);
		await bridge.mysqlEnd();
		assert.equal((await bridge.mysqlOneShot(ENV, 'SELECT 1')).ok, true);
	});
	assert.equal(named(ev, 'connect-timeout').length + named(ev, 'db-end-timeout').length, 0, JSON.stringify(ev));
});

// #1178 (joan, cf759hl): a warm isolate's lean socket closed MID-PACKET. The connector kept the dead connection, so 5
// statements of the run failed (wp_users among them), all classed "deterministic", and the request answered a confident
// 401 "Unknown username". A connection fault is not the statement's fault:
// - a read that fails that way gets a NEW connection and ONE retry;
// - a write is never retried blind (it may have been applied), but later statements get a new connection;
// - inside a transaction nothing reconnects: the rest of the run fails, so no write lands outside its transaction.
const MID = 'mysql: socket closed mid-packet';
function scripted(answers) { // each connection answers from its own list; every connect is counted
	const st = { connects: 0, destroyed: 0, queries: [] };
	lean.connect = async () => {
		const n = st.connects++;
		const list = answers[n] || answers[answers.length - 1];
		let i = 0;
		return { query: async (sql) => { st.queries.push([n, sql]); const a = list[Math.min(i++, list.length - 1)]; if (a instanceof Error) throw a; return a; }, end: async () => {}, destroy: () => { st.destroyed++; } };
	};
	bridge.mysqlReset();
	return st;
}
const rows = { kind: 'rows', columns: [{ name: 'ID', characterSet: 33 }], rows: [[Buffer.from('1')]] };
const okw = { kind: 'ok', affectedRows: 1, insertId: 0 };
test('#1178 a SELECT whose socket closes mid-packet is retried ONCE on a new connection, with the right answer', async () => {
	const st = scripted([[new Error(MID)], [rows]]);
	const r = await bridge.mysqlQuery(ENV, { mysql: "SELECT ID FROM wp_users WHERE user_login = 'admin'" });
	assert.equal(r.ok, true, JSON.stringify(r));
	assert.deepEqual(r.rows, [['1']]);
	assert.equal(st.connects, 2);
	assert.ok(st.destroyed >= 1, 'the dead connection is torn down');
	await bridge.mysqlEnd();
});
test('#1178 a write whose socket closes mid-packet is NOT retried, and the next statement gets a new connection', async () => {
	const st = scripted([[new Error(MID)], [rows]]);
	const w = await bridge.mysqlQuery(ENV, { mysql: "UPDATE wp_options SET option_value = 'x' WHERE option_name = 'y'" });
	assert.equal(w.ok, false);
	assert.match(w.error, /mid-packet/);
	assert.equal(st.queries.filter(([, q]) => /^UPDATE/.test(q)).length, 1, 'sent once, never twice');
	const r = await bridge.mysqlQuery(ENV, { mysql: 'SELECT ID FROM wp_users' });
	assert.equal(r.ok, true, 'no cascade: the dead connection is not reused');
	assert.equal(st.connects, 2);
	await bridge.mysqlEnd();
});
test('#1178 inside a transaction a connection fault is not retried, and the rest of the run fails until its end', async () => {
	const st = scripted([[okw, new Error(MID)], [okw]]);
	assert.equal((await bridge.mysqlQuery(ENV, { mysql: 'START TRANSACTION' })).ok, true);
	const r = await bridge.mysqlQuery(ENV, { mysql: 'SELECT ID FROM wp_posts' });
	assert.equal(r.ok, false);
	const w = await bridge.mysqlQuery(ENV, { mysql: "INSERT INTO wp_posts (post_title) VALUES ('x')" });
	assert.equal(w.ok, false, 'never written outside the lost transaction');
	assert.equal(st.connects, 1, 'no reconnect inside the run');
	await bridge.mysqlEnd();
	assert.equal((await bridge.mysqlQuery(ENV, { mysql: 'SELECT 1' })).ok, true, 'the next run starts clean');
	await bridge.mysqlEnd();
});
test('#1178 a statement error (the SQL itself) is never retried', async () => {
	const e = Object.assign(new Error("Table 'd.wp_x' doesn't exist"), { errno: 1146 });
	const st = scripted([[e], [rows]]);
	const r = await bridge.mysqlQuery(ENV, { mysql: 'SELECT * FROM wp_x' });
	assert.equal(r.ok, false);
	assert.equal(st.connects, 1);
	await bridge.mysqlEnd();
});
test('#1178 session-state reads are never retried on a new connection (FOUND_ROWS, LAST_INSERT_ID, GET_LOCK, FOR UPDATE)', async () => {
	for (const q of ['SELECT FOUND_ROWS()', 'SELECT LAST_INSERT_ID()', "SELECT GET_LOCK('x', 0)", 'SELECT * FROM wp_posts WHERE ID = 1 FOR UPDATE']) {
		const st = scripted([[new Error(MID)], [rows]]);
		assert.equal((await bridge.mysqlQuery(ENV, { mysql: q })).ok, false, q);
		assert.equal(st.queries.filter(([, s]) => s === q).length, 1, q + ' sent once');
		await bridge.mysqlEnd();
	}
});

// #1179 review (the lead): a retried read runs on a NEW connection. Does it get the same session? On approach A:
// - Hyperdrive resets the session after EVERY statement (measured, tests/a2 probe E1; php/hyperdrive-db.php), so no
//   per-connection SET holds even on the old connection: set_charset() and set_sql_mode() are deliberate no-ops;
// - the charset (utf8mb4, collation 45) is in the connect HANDSHAKE, so every connection has it;
// - a strict server's sql_mode rides inside each statement (hyperdrive-sql-mode.php), so the retry, the same SQL
//   text, carries it;
// - the only session SETs (the DDL path, the SQL import) run inside BEGIN ... COMMIT, where nothing reconnects;
// - nothing sets time_zone.
// User @variables and TEMPORARY tables are excluded from the retry anyway.
test('#1179 review: the retry sends the byte-identical statement (a per-statement sql_mode hint comes along)', async () => {
	const st = scripted([[new Error(MID)], [rows]]);
	const q = "SELECT /*+ SET_VAR(sql_mode = 'NO_ENGINE_SUBSTITUTION') */ ID FROM wp_users";
	assert.equal((await bridge.mysqlQuery(ENV, { mysql: q })).ok, true);
	assert.deepEqual(st.queries.map(([, s]) => s), [q, q]);
	await bridge.mysqlEnd();
});
test('#1179 review: the session setup is in the handshake, never a per-connection SET a reconnect could miss', () => {
	const lean = readFileSync(new URL('../mysql-lean.js', import.meta.url), 'utf8');
	assert.match(lean, /const CHARSET_UTF8MB4 = 45;/);
	assert.match(lean, /head\[8\] = CHARSET_UTF8MB4;/, 'every connect sends utf8mb4 in its handshake response');
	const br = readFileSync(new URL('../mysql-lean-bridge.js', import.meta.url), 'utf8');
	for (const s of [lean, br]) assert.doesNotMatch(s, /SET\s+(NAMES|SESSION|CHARACTER|time_zone|@)/i, 'no session SET on connect');
	const db = readFileSync(new URL('../php/hyperdrive-db.php', import.meta.url), 'utf8');
	assert.match(db, /public function set_charset\( \$dbh, \$charset = null, \$collate = null \) \{\}/, 'WordPress sets no charset per connection');
	assert.match(db, /public function set_sql_mode\( \$modes = array\(\) \) \{\}/, 'nor sql_mode');
	assert.match(db, /skyphusion_hd_call\( 'BEGIN' \);[\s\S]*SET SESSION sql_mode/, 'the DDL path SETs only inside a transaction (never retried)');
});
test('#1179 review: reads using @user variables are never retried', async () => {
	for (const q of ['SELECT @pf_x', 'SELECT ID FROM wp_posts WHERE ID > @last']) {
		const st = scripted([[new Error(MID)], [rows]]);
		assert.equal((await bridge.mysqlQuery(ENV, { mysql: q })).ok, false, q);
		assert.equal(st.queries.length, 1, q);
		await bridge.mysqlEnd();
	}
	const st = scripted([[new Error(MID)], [rows]]);
	assert.equal((await bridge.mysqlQuery(ENV, { mysql: "SELECT ID FROM wp_users WHERE user_email = 'a@b.example'" })).ok, true, 'an @ inside a string literal is not a variable');
	await bridge.mysqlEnd();
});
test('#1179 review: reads of a TEMPORARY table this run created are never retried', async () => {
	const st = scripted([[okw, new Error(MID)], [rows]]);
	assert.equal((await bridge.mysqlQuery(ENV, { mysql: 'CREATE TEMPORARY TABLE IF NOT EXISTS `pf_tmp` (id INT)' })).ok, true);
	assert.equal((await bridge.mysqlQuery(ENV, { mysql: 'SELECT id FROM pf_tmp' })).ok, false);
	assert.equal(st.connects, 1);
	await bridge.mysqlEnd();
});

// #1179 CodeQL (incomplete string escaping): the temp-table check built a RegExp from a table name, escaping only $.
// Names are now compared as identifier TOKENS, never as a pattern, and a backtick-quoted name may hold any character.
test('#1179 temp-table names with regex metacharacters are matched exactly, as tokens', async () => {
	const { retryableRead, sqlIdentifiers } = await import('../mysql-fault.mjs');
	const t = new Set(['pf.tmp+(1)[x]\\y']);
	assert.equal(retryableRead('SELECT id FROM `pf.tmp+(1)[x]\\y`', t), false, 'the same name: not retried');
	assert.equal(retryableRead('SELECT id FROM pfXtmp', t), true, 'a . in the name is not a wildcard');
	assert.equal(retryableRead('SELECT id FROM `pf.tmp+(1)[x]\\yz`', t), true, 'a longer name is another table');
	assert.equal(retryableRead('SELECT id FROM PF_TMP', new Set(['pf_tmp'])), false, 'case-insensitive, as MySQL on this server');
	assert.equal(retryableRead('SELECT pf_tmp_count FROM wp_x', new Set(['pf_tmp'])), true, 'a token, not a substring');
	assert.deepEqual(sqlIdentifiers("SELECT a.`b c` FROM `t` WHERE x = 'pf_tmp'"), ['select', 'a', 'b c', 'from', 't', 'where', 'x'], 'literals are not identifiers');
});
test('#1179 a backtick-quoted temp table with metacharacters is tracked, and its reads are not retried', async () => {
	const st = scripted([[okw, new Error(MID)], [rows]]);
	assert.equal((await bridge.mysqlQuery(ENV, { mysql: 'CREATE TEMPORARY TABLE `pf.t+1` (id INT)' })).ok, true);
	assert.equal((await bridge.mysqlQuery(ENV, { mysql: 'SELECT id FROM `pf.t+1`' })).ok, false);
	assert.equal(st.connects, 1);
	await bridge.mysqlEnd();
});
