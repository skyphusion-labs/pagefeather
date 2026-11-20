// Approach A database bridge on the lean MySQL client (mysql-lean.js) instead
// of mysql2. Drop-in for mysql-bridge.js: same exports (mysqlQuery / mysqlEnd /
// mysqlReset) and the same wire shape back to php/hyperdrive-db.php, so the PHP
// side and index.js cannot tell which client ran. mysql2 is never imported, so
// with ENGINE=a DB_CLIENT=lean it is absent from the bundle and from the
// isolate's JS heap (issue #218: reclaim the headroom the Woo write needs).
//
// Values come back as php/hyperdrive-db.php expects: a text column as a UTF-8
// string, a binary-charset column (63) as {"$b": base64}, NULL as null.
import { LeanMysql } from './mysql-lean.js';
import { Buffer } from 'node:buffer';

import { createConnector } from './connector.mjs';

// #1101: approach A's DEFAULT bridge (index-a-lean.js). One connection per PHP run (#1087), opened on first use. A rejected
// connect is retried once and never cached; the connect is bounded (3 s) and end() too (2 s, then destroy()), so a dead
// socket can neither poison a run's statements nor hang the post-response waitUntil (cf759hx, #1101).
const log = (o) => console.log(JSON.stringify(o));
const openLean = (env) => () =>
	LeanMysql.connect({
		host: env.HYPERDRIVE.host,
		user: env.HYPERDRIVE.user,
		password: env.HYPERDRIVE.password,
		database: env.HYPERDRIVE.database,
		port: env.HYPERDRIVE.port,
	});
let ENV_FOR_CONNECT = null;
const connector = createConnector(() => openLean(ENV_FOR_CONNECT)(), { log });
function connection(env) {
	ENV_FOR_CONNECT = env;
	return connector.get();
}

export async function mysqlQuery(env, m) {
	if (m.mysql_b64 !== undefined) return { ok: false, error: 'mysql_b64 is not supported: send binary string literals as hex literals', errno: 2000 };
	const sql = m.mysql;
	try {
		const c = await connection(env);
		const res = await c.query(sql);
		if (res.kind === 'ok') return { ok: true, affected: res.affectedRows || 0, insert_id: res.insertId || 0 };
		const binary = res.columns.map((f) => f.characterSet === 63);
		const rows = res.rows.map((r) => r.map((v, i) => (v === null ? null : binary[i] ? { $b: Buffer.from(v).toString('base64') } : Buffer.from(v).toString('utf8'))));
		return { ok: true, columns: res.columns.map((f) => f.name), rows };
	} catch (e) {
		const error = String((e && e.message) || e);
		return { ok: false, error, errno: e && e.errno };
	}
}

// One query on its OWN connection, opened and closed here (#296 step 1: the gateway reads the page
// version before it calls the cached Pages entrypoint, and must share no connection with it). The
// same reply shape as mysqlQuery.
export async function mysqlOneShot(env, sql) {
	// #1101: its own connector, so its connect and its end are bounded too (the page-version read, the idle cron gate and
	// the upload sweep call this).
	const one = createConnector(openLean(env), { log });
	try {
		const c = await one.get();
		const res = await c.query(sql);
		if (res.kind === 'ok') return { ok: true, affected: res.affectedRows || 0, insert_id: res.insertId || 0 };
		const binary = res.columns.map((f) => f.characterSet === 63);
		const rows = res.rows.map((r) => r.map((v, i) => (v === null ? null : binary[i] ? { $b: Buffer.from(v).toString('base64') } : Buffer.from(v).toString('utf8'))));
		return { ok: true, columns: res.columns.map((f) => f.name), rows };
	} catch (e) {
		return { ok: false, error: String((e && e.message) || e), errno: e && e.errno };
	} finally {
		await one.end();
	}
}

// Forget a connection another request opened (a Worker request cannot touch another request's I/O). Not closed here.
export function mysqlReset() {
	connector.reset();
}

// The end of a PHP run: references cleared first, then a bounded close (destroy() past the bound).
export async function mysqlEnd() {
	await connector.end();
}
