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
	assert.match(bridge, /export async function mysqlEnd\(\) \{\n\tawait connector\.end\(\);\n\}/);
});
