// Probe for issue #50: WordPress on PlanetScale (Vitess MySQL) through
// Hyperdrive. Two questions, answered in JSON, with the same driver settings
// as spikes/b2-wordpress/mysql-bridge.js (mysql2, one connection per request).
//
//   GET /latency?n=20   per-statement time through each Hyperdrive binding
//                       (HD_GLOBAL: aws.connect.psdb.cloud, HD_DIRECT:
//                       aws-us-east-2.connect.psdb.cloud), and the colo.
//   GET /session        can a relaxed sql_mode reach the server? Judged by
//                       effect (strict refusals of zero dates and GROUP BY):
//                       SET on one client connection, SET in a transaction,
//                       the SET_VAR hint, a leak to another client, and the
//                       DDL rewrite. Scratch tables a2probe_*_<time>, dropped.
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

// Judged by EFFECT, never by read-back: through Vitess, SELECT @@SESSION.sql_mode
// and SELECT @@GLOBAL.sql_mode return zero rows (2026-11-06T00:32Z), so the
// mode cannot be read. Each test runs a statement that strict mode refuses and
// records whether it ran: a zero-date DEFAULT in DDL (errno 1067), a zero-date
// value in DML (errno 1292), a GROUP BY that ONLY_FULL_GROUP_BY refuses (1055).
// RELAXED is an explicit list: MySQL's default without wpdb's incompatible
// modes and without NO_ZERO_IN_DATE.
const RELAXED = 'ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const HINT = "/*+ SET_VAR(sql_mode='" + RELAXED + "') */";
const ZERO = "'0000-00-00 00:00:00'";

async function session(env) {
	const out = { relaxed_mode: RELAXED, steps: {}, verdict: {} };
	const st = (k, v) => (out.steps[k] = v);
	const ran = (r) => !!(r && r.ok);
	const stamp = Date.now();
	const tables = [];
	const name = (k) => {
		const t = 'a2probe_' + k + '_' + stamp;
		tables.push(t);
		return t;
	};
	const zeroDdl = (t) => 'CREATE TABLE ' + t + ' (id int NOT NULL PRIMARY KEY, d datetime NOT NULL DEFAULT ' + ZERO + ", k varchar(10) NOT NULL DEFAULT '')";
	const conns = [];
	const open = async () => {
		const c = await connect(env.HD_DIRECT);
		conns.push(c);
		return c;
	};
	try {
		const a = await open();
		st('server_session_mode', await q(a, 'SELECT @@SESSION.sql_mode'));
		st('server_global_mode', await q(a, 'SELECT @@GLOBAL.sql_mode'));
		st('server_version', await q(a, 'SELECT VERSION()'));
		st('server_connection_id', await q(a, 'SELECT CONNECTION_ID()'));

		// A helper table any strict server accepts (no zero default), for DML tests.
		const TD = name('dml');
		st('setup_dml_table', await q(a, 'CREATE TABLE ' + TD + " (id int NOT NULL PRIMARY KEY, d datetime NULL, k varchar(10) NOT NULL DEFAULT '', n int NOT NULL)"));
		if (!ran(out.steps.setup_dml_table)) {
			out.error = 'could not make the helper table: see steps.setup_dml_table';
			return out;
		}
		await q(a, 'INSERT INTO ' + TD + " (id, d, k, n) VALUES (100, NULL, 'a', 1), (101, NULL, 'a', 2)");

		// E0: the baseline. Strict mode must refuse these, or the tests below mean nothing.
		st('E0_ddl_plain', await q(a, zeroDdl(name('e0'))));
		st('E0_dml_plain', await q(a, 'INSERT INTO ' + TD + ' (id, d, n) VALUES (1, ' + ZERO + ', 0)'));
		st('E0_group_plain', await q(a, 'SELECT id, k FROM ' + TD + ' GROUP BY k'));
		out.verdict.strict_refuses_zero_ddl = !ran(out.steps.E0_ddl_plain);
		out.verdict.strict_refuses_zero_dml = !ran(out.steps.E0_dml_plain);
		out.verdict.strict_refuses_group_by = !ran(out.steps.E0_group_plain);

		// E1: SET on one client connection, no transaction, then DDL and 5 DML statements.
		const b = await open();
		st('E1_set', await q(b, "SET SESSION sql_mode = '" + RELAXED + "'"));
		st('E1_ddl', await q(b, zeroDdl(name('e1'))));
		const e1 = [];
		for (let i = 0; i < 5; i++) e1.push(await q(b, 'INSERT INTO ' + TD + ' (id, d, n) VALUES (' + (10 + i) + ', ' + ZERO + ', 0)'));
		st('E1_dml', e1);
		st('E1_group', await q(b, 'SELECT id, k FROM ' + TD + ' GROUP BY k'));
		out.verdict.E1_set_reaches_ddl = ran(out.steps.E1_ddl);
		out.verdict.E1_set_reaches_dml = e1.filter(ran).length + ' of 5';
		out.verdict.E1_set_reaches_group_by = ran(out.steps.E1_group);

		// LEAK: a different client connection, no SET of its own. If this runs, a
		// SET leaked through the pool to another client (a correctness problem).
		const c = await open();
		st('LEAK_dml_other_client', await q(c, 'INSERT INTO ' + TD + ' (id, d, n) VALUES (20, ' + ZERO + ', 0)'));
		out.verdict.LEAK_set_seen_by_other_client = ran(out.steps.LEAK_dml_other_client);

		// E2: SET inside an explicit transaction, then DDL (MySQL commits before
		// DDL) and DML.
		const d = await open();
		st('E2_begin', await q(d, 'BEGIN'));
		st('E2_set', await q(d, "SET SESSION sql_mode = '" + RELAXED + "'"));
		st('E2_dml', await q(d, 'INSERT INTO ' + TD + ' (id, d, n) VALUES (30, ' + ZERO + ', 0)'));
		st('E2_commit', await q(d, 'COMMIT'));
		st('E2b_begin', await q(d, 'BEGIN'));
		st('E2b_set', await q(d, "SET SESSION sql_mode = '" + RELAXED + "'"));
		st('E2b_ddl', await q(d, zeroDdl(name('e2'))));
		st('E2b_commit', await q(d, 'COMMIT'));
		out.verdict.E2_txn_set_reaches_dml = ran(out.steps.E2_dml);
		out.verdict.E2_txn_set_reaches_ddl = ran(out.steps.E2b_ddl);

		// E3: the SET_VAR hint, on a fresh connection with no SET.
		const e = await open();
		st('E3_insert_hint', await q(e, 'INSERT ' + HINT + ' INTO ' + TD + ' (id, d, n) VALUES (40, ' + ZERO + ', 0)'));
		st('E3_update_hint', await q(e, 'UPDATE ' + HINT + ' ' + TD + ' SET d = ' + ZERO + ' WHERE id = 100'));
		st('E3_select_hint', await q(e, 'SELECT ' + HINT + ' id, k FROM ' + TD + ' GROUP BY k'));
		st('E3_delete_hint', await q(e, 'DELETE ' + HINT + ' FROM ' + TD + ' WHERE d = ' + ZERO + ' AND id = 40'));
		out.verdict.E3_hint_reaches_insert = ran(out.steps.E3_insert_hint);
		out.verdict.E3_hint_reaches_update = ran(out.steps.E3_update_hint);
		out.verdict.E3_hint_reaches_group_by = ran(out.steps.E3_select_hint);
		out.verdict.E3_hint_reaches_delete = ran(out.steps.E3_delete_hint);

		// R: the DDL rewrite. Drop the zero DEFAULT (strict accepts the DDL); with
		// the hint, an INSERT that leaves the column out gets MySQL's implicit
		// zero default, as stock WordPress expects.
		const TR = name('rw');
		st('R_ddl_no_default', await q(e, 'CREATE TABLE ' + TR + " (id int NOT NULL PRIMARY KEY, d datetime NOT NULL, k varchar(10) NOT NULL DEFAULT '')"));
		st('R_insert_omit_plain', await q(e, 'INSERT INTO ' + TR + " (id, k) VALUES (1, 'x')"));
		st('R_insert_omit_hint', await q(e, 'INSERT ' + HINT + ' INTO ' + TR + " (id, k) VALUES (2, 'x')"));
		st('R_read', await q(e, 'SELECT ' + HINT + ' id, CAST(d AS CHAR) FROM ' + TR + ' ORDER BY id'));
		out.verdict.R_ddl_without_zero_default_ok = ran(out.steps.R_ddl_no_default);
		out.verdict.R_omitted_column_gets_zero_with_hint = ran(out.steps.R_insert_omit_hint);
	} catch (e) {
		out.error = 'probe: ' + String((e && e.message) || e);
	} finally {
		// Drop every scratch table that exists, whatever happened.
		const cl = conns[0];
		if (cl) {
			const drops = [];
			for (const t of tables) drops.push(await q(cl, 'DROP TABLE IF EXISTS ' + t));
			out.steps.cleanup = drops;
			const left = await q(cl, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'a2probe\\_%\\_" + stamp + "'");
			out.tables_left = cell(left);
		}
		for (const x of conns) await x.end().catch(() => {});
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
