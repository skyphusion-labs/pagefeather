// Probe for issue #50: WordPress on PlanetScale (Vitess MySQL) through
// Hyperdrive. Two questions, answered in JSON, with the same driver settings
// as spikes/b2-wordpress/mysql-bridge.js (mysql2, one connection per request).
//
//   GET /latency?n=20   per-statement time through each Hyperdrive binding
//                       (HD_GLOBAL: aws.connect.psdb.cloud, HD_DIRECT:
//                       aws-us-east-2.connect.psdb.cloud), and the colo.
//   GET /session        can WordPress's relaxed sql_mode reach the server?
//                       S: session state on one client connection, in a
//                       transaction, as a SET_VAR hint. D: DDL and DML with a
//                       zero date on a scratch table (dropped at the end).
//
// Every call needs the header x-probe-token (secret PROBE_TOKEN): /session
// makes and drops a table in the database.
import { createConnection } from 'mysql2/promise';

function connect(hd) {
	return createConnection({
		host: hd.host,
		user: hd.user,
		password: hd.password,
		database: hd.database,
		port: hd.port,
		disableEval: true,
		multipleStatements: false,
		charset: 'utf8mb4',
	});
}

// One statement. Never throws: a failure is a result.
// The answer's shape is recorded (rows, or an OK packet with no rows), because
// the first run threw on a SELECT that came back without rows (2026-11-06).
async function q(c, sql) {
	const t0 = performance.now();
	try {
		const res = await c.query({ sql, rowsAsArray: true });
		const rows = Array.isArray(res) ? res[0] : res;
		const ms = performance.now() - t0;
		if (Array.isArray(rows)) return { sql, ok: true, shape: 'rows', rows: rows.map((r) => (Array.isArray(r) ? r.map(String) : r)), ms };
		const o = rows && typeof rows === 'object' ? rows : {};
		return {
			sql,
			ok: true,
			shape: 'ok-packet',
			affected: o.affectedRows,
			info: o.info,
			serverStatus: o.serverStatus,
			warningStatus: o.warningStatus,
			fieldCount: o.fieldCount,
			raw_type: rows === null ? 'null' : typeof rows,
			ms,
		};
	} catch (e) {
		return { sql, ok: false, errno: e && e.errno, error: String((e && e.message) || e).slice(0, 300), ms: performance.now() - t0 };
	}
}

// One cell of a result, or undefined. Never throws.
const cell = (r, i = 0, j = 0) => (r && r.ok && Array.isArray(r.rows) && Array.isArray(r.rows[i]) ? r.rows[i][j] : undefined);

// wpdb::set_sql_mode(): the modes WordPress removes from the server's sql_mode.
const WP_INCOMPATIBLE = ['NO_ZERO_DATE', 'ONLY_FULL_GROUP_BY', 'STRICT_TRANS_TABLES', 'STRICT_ALL_TABLES', 'TRADITIONAL', 'ANSI'];
const relax = (mode) =>
	String(mode || '')
		.split(',')
		.filter((m) => m && !WP_INCOMPATIBLE.includes(m.toUpperCase()))
		.join(',');

const median = (v) => {
	const s = [...v].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : null;
};

async function latency(env, n) {
	const out = {};
	for (const [name, hd] of [
		['global', env.HD_GLOBAL],
		['direct', env.HD_DIRECT],
	]) {
		const r = { host_binding: name };
		const t0 = performance.now();
		let c;
		try {
			c = await connect(hd);
			r.connect_ms = performance.now() - t0;
			const first = await q(c, 'SELECT 1');
			r.first_ms = first.ms;
			const ms = [];
			for (let i = 0; i < n; i++) {
				const x = await q(c, "SELECT 'probe' AS v, " + i + ' AS i');
				if (!x.ok) {
					r.error = x.error;
					break;
				}
				ms.push(x.ms);
			}
			r.n = ms.length;
			r.median_ms = median(ms);
			r.min_ms = Math.min(...ms);
			r.max_ms = Math.max(...ms);
		} catch (e) {
			r.error = String((e && e.message) || e).slice(0, 300);
		} finally {
			if (c) await c.end().catch(() => {});
		}
		out[name] = r;
	}
	return out;
}

async function session(env) {
	const c = await connect(env.HD_DIRECT);
	const out = { steps: {} };
	const s = (k, v) => (out.steps[k] = v);
	try {
		s('server_session_mode', await q(c, 'SELECT @@SESSION.sql_mode'));
		s('server_global_mode', await q(c, 'SELECT @@GLOBAL.sql_mode'));
		s('server_version', await q(c, 'SELECT VERSION()'));
		s('server_connection_id', await q(c, 'SELECT CONNECTION_ID()'));
		const serverMode = cell(out.steps.server_session_mode);
		if (serverMode === undefined) {
			out.error = 'SELECT @@SESSION.sql_mode returned no row: see steps.server_session_mode';
			return out;
		}
		const relaxed = relax(serverMode);
		out.server_mode = serverMode;
		out.relaxed_mode = relaxed;
		const hint = "/*+ SET_VAR(sql_mode='" + relaxed + "') */";

		// S1: SET on this client connection, no transaction, then read it back 10 times.
		s('S1_set', await q(c, "SET SESSION sql_mode = '" + relaxed + "'"));
		const reads = [];
		for (let i = 0; i < 10; i++) reads.push(await q(c, 'SELECT @@SESSION.sql_mode, CONNECTION_ID()'));
		s('S1_reads', reads);
		out.S1_kept_all = reads.every((r) => cell(r) === relaxed);
		// Back to the server mode for the tests below.
		await q(c, "SET SESSION sql_mode = '" + serverMode + "'");

		// S2: in an explicit transaction.
		s('S2_begin', await q(c, 'BEGIN'));
		s('S2_set', await q(c, "SET SESSION sql_mode = '" + relaxed + "'"));
		const s2 = await q(c, 'SELECT @@SESSION.sql_mode');
		s('S2_read', s2);
		s('S2_commit', await q(c, 'COMMIT'));
		out.S2_kept_in_transaction = cell(s2) === relaxed;
		await q(c, "SET SESSION sql_mode = '" + serverMode + "'");

		// S3: the SET_VAR hint, through Vitess to MySQL.
		const s3 = await q(c, 'SELECT ' + hint + ' @@SESSION.sql_mode');
		s('S3_hint', s3);
		out.S3_hint_applies = cell(s3) === relaxed;

		// D: a scratch table with WordPress's zero-date default.
		const T = 'a2probe_' + Date.now();
		const ddl = 'CREATE TABLE ' + T + " (id int NOT NULL PRIMARY KEY, d datetime NOT NULL DEFAULT '0000-00-00 00:00:00', k varchar(10) NOT NULL DEFAULT '')";
		s('D1_ddl_plain', await q(c, ddl));
		out.D1_plain_ddl_ok = out.steps.D1_ddl_plain.ok;
		if (!out.D1_plain_ddl_ok) {
			// D2: the DDL after SET in a transaction (MySQL commits before DDL).
			s('D2_begin', await q(c, 'BEGIN'));
			s('D2_set', await q(c, "SET SESSION sql_mode = '" + relaxed + "'"));
			s('D2_ddl', await q(c, ddl));
			s('D2_commit', await q(c, 'COMMIT'));
			out.D2_txn_ddl_ok = out.steps.D2_ddl.ok;
			await q(c, "SET SESSION sql_mode = '" + serverMode + "'");
		}
		const made = await q(c, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '" + T + "'");
		out.table_made = String(cell(made)) === '1';
		if (out.table_made) {
			s('D_show', await q(c, 'SHOW CREATE TABLE ' + T));
			// D3: a zero-date value, plain (strict) and with the hint.
			s('D3_insert_plain', await q(c, 'INSERT INTO ' + T + " (id, d) VALUES (1, '0000-00-00 00:00:00')"));
			s('D3_insert_hint', await q(c, 'INSERT ' + hint + ' INTO ' + T + " (id, d) VALUES (2, '0000-00-00 00:00:00')"));
			// D4: a column left out (its default is the zero date).
			s('D4_insert_default_hint', await q(c, 'INSERT ' + hint + ' INTO ' + T + " (id, k) VALUES (3, 'x')"));
			s('D5_update_hint', await q(c, 'UPDATE ' + hint + ' ' + T + " SET d = '0000-00-00 00:00:00' WHERE id = 3"));
			s('D6_select_hint', await q(c, 'SELECT ' + hint + ' id, d FROM ' + T + " WHERE d = '0000-00-00 00:00:00' ORDER BY id"));
			// G: ONLY_FULL_GROUP_BY, plain and with the hint.
			s('G1_group_plain', await q(c, 'SELECT id, k FROM ' + T + ' GROUP BY k'));
			s('G2_group_hint', await q(c, 'SELECT ' + hint + ' id, k FROM ' + T + ' GROUP BY k'));
			s('D7_delete_hint', await q(c, 'DELETE ' + hint + ' FROM ' + T + ' WHERE id = 2'));
			s('D_drop', await q(c, 'DROP TABLE ' + T));
		}
		out.table = T;
	} catch (e) {
		out.error = 'probe: ' + String((e && e.message) || e);
	} finally {
		await c.end().catch(() => {});
	}
	return out;
}

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (!env.PROBE_TOKEN || req.headers.get('x-probe-token') !== env.PROBE_TOKEN) return new Response('forbidden', { status: 403 });
		// req.cf.colo is where the request came in. With a placement hint the
		// Worker runs elsewhere: /cdn-cgi/trace from inside shows where.
		const colo = { ingress: req.cf && req.cf.colo };
		try {
			const t = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text();
			colo.run = (t.match(/^colo=(.*)$/m) || [])[1] || null;
		} catch {
			colo.run = null;
		}
		try {
			if (url.pathname === '/latency') {
				const n = Math.max(1, Math.min(Number(url.searchParams.get('n') || 20), 200));
				return Response.json({ colo, utc: new Date().toISOString(), latency: await latency(env, n) });
			}
			if (url.pathname === '/session') return Response.json({ colo, utc: new Date().toISOString(), ...(await session(env)) });
		} catch (e) {
			return Response.json({ colo, error: String((e && e.message) || e) }, { status: 500 });
		}
		return new Response('not found', { status: 404 });
	},
};
