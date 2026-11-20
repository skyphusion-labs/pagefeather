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

import { createConnector } from './connector.mjs';

// #1101: one connection per PHP run (#1087), opened on first use; a rejected connect is retried once, never cached.
let ENV_FOR_CONNECT = null;
// connect-timeout and db-end-timeout lines go to the Worker log (bounded awaits under the PHP lock, #1101).
const connector = createConnector(() =>
	createConnection({
		host: ENV_FOR_CONNECT.HYPERDRIVE.host,
		user: ENV_FOR_CONNECT.HYPERDRIVE.user,
		password: ENV_FOR_CONNECT.HYPERDRIVE.password,
		database: ENV_FOR_CONNECT.HYPERDRIVE.database,
		port: ENV_FOR_CONNECT.HYPERDRIVE.port,
		disableEval: true, // Workers do not allow eval()
		multipleStatements: false,
		charset: 'utf8mb4',
	}),
	{ log: (o) => console.log(JSON.stringify(o)) },
);
function connection(env) {
	ENV_FOR_CONNECT = env;
	return connector.get();
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

// At the start of a PHP run (db-lifecycle.mjs withDbRun): forget a connection another context opened. It is not closed
// or awaited here: a Worker request cannot touch another request's I/O, and awaiting it hangs (measured 2026-11-05).
export function mysqlReset() {
	connector.reset();
}

// At the end of each PHP run: the references are cleared first, so the next run opens its own connection even while this
// one closes.
export async function mysqlEnd() {
	await connector.end();
}
