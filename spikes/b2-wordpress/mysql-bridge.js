// Approach A: run WordPress's MySQL queries on the Hyperdrive binding.
// php/hyperdrive-db.php sends {mysql: sql}, always valid UTF-8 (binary string
// literals as hex literals, issue #79), through post_message_to_js. One connection per Worker request: a
// Worker cannot use an I/O object from another request, and Hyperdrive pools
// the real connections to the database.
//
// Values come back the way mysqli returns them: strings, or null. typeCast is
// off, so mysql2 gives raw bytes; a column with the binary character set (63:
// BLOB, BINARY, VARBINARY) is sent as {"$b": base64}, text as a string. (B
// lost BLOBs in JSON; found 2026-11-05 with Wordfence.)
import { createConnection } from 'mysql2/promise';
import { Buffer } from 'node:buffer';

let conn = null;
let connecting = null;

async function connection(env) {
	if (conn) return conn;
	if (!connecting) {
		connecting = createConnection({
			host: env.HYPERDRIVE.host,
			user: env.HYPERDRIVE.user,
			password: env.HYPERDRIVE.password,
			database: env.HYPERDRIVE.database,
			port: env.HYPERDRIVE.port,
			disableEval: true, // Workers do not allow eval()
			multipleStatements: false,
			charset: 'utf8mb4',
		}).then((c) => {
			conn = c;
			return c;
		});
	}
	return connecting;
}

export async function mysqlQuery(env, m) {
	// SQL comes as JSON text. php/hyperdrive-literals.php sends binary string
	// literals as hex literals. The old {mysql_b64} form was decoded as latin1
	// and stored every byte above 0x7F as two (issue #79): refused, not decoded.
	if (m.mysql_b64 !== undefined) return { ok: false, error: 'mysql_b64 is not supported: send binary string literals as hex literals', errno: 2000 };
	const sql = m.mysql;
	try {
		const c = await connection(env);
		const [result, fields] = await c.query({ sql, rowsAsArray: true, typeCast: false });
		if (!Array.isArray(result)) return { ok: true, affected: result.affectedRows || 0, insert_id: result.insertId || 0 };
		const binary = (fields || []).map((f) => f.characterSet === 63);
		const rows = result.map((r) => r.map((v, i) => (v === null ? null : binary[i] ? { $b: Buffer.from(v).toString('base64') } : Buffer.from(v).toString('utf8'))));
		return { ok: true, columns: (fields || []).map((f) => f.name), rows };
	} catch (e) {
		const error = String((e && e.message) || e);
		return { ok: false, error, errno: e && e.errno };
	}
}

// At the start of a request: forget a connection another request opened. It is
// not closed or awaited here: a Worker request cannot touch another request's
// I/O, and awaiting it hangs (measured 2026-11-05 after /_install).
export function mysqlReset() {
	conn = null;
	connecting = null;
}

// Call at the end of each Worker request. The references are cleared first,
// so the next request opens its own connection even while this one closes.
export async function mysqlEnd() {
	const c = conn;
	const pending = connecting;
	conn = null;
	connecting = null;
	const done = c || (pending && (await pending.catch(() => null)));
	if (done) await done.end().catch(() => {});
}
