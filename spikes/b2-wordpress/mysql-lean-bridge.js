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

let conn = null;
let connecting = null;

async function connection(env) {
	if (conn) return conn;
	if (!connecting) {
		connecting = LeanMysql.connect({
			host: env.HYPERDRIVE.host,
			user: env.HYPERDRIVE.user,
			password: env.HYPERDRIVE.password,
			database: env.HYPERDRIVE.database,
			port: env.HYPERDRIVE.port,
		}).then((c) => {
			conn = c;
			return c;
		});
	}
	return connecting;
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

// Forget a connection another request opened (a Worker request cannot touch
// another request's I/O). Not closed here: awaiting it hangs.
export function mysqlReset() {
	conn = null;
	connecting = null;
}

export async function mysqlEnd() {
	const c = conn;
	const pending = connecting;
	conn = null;
	connecting = null;
	const done = c || (pending && (await pending.catch(() => null)));
	if (done) await done.end().catch(() => {});
}
