// Import an existing site's MySQL dump into variant a's database (issue #31,
// deploy/import.sh, deploy/import/mysql-prepare.py). Variant a only: PHP in the
// Worker, MySQL (MariaDB, or PlanetScale for a2) through Hyperdrive.
//
//   GET  /_sqlimport?info=1    {version, flavour, max_allowed_packet}
//   GET  /_sqlimport?counts=1  {tables: {name: {rows, min_pk}}} for wp_ tables;
//                              a count that is not an integer is a 500, not a null
//   POST /_sqlimport[?replace=1]  JSON lines {"sql": "..."}, in order
//
// It needs the SPIKE_TOKEN secret and its x-spike-token header (no token set:
// refused, unlike other spike endpoints). Every statement must pass
// checkStatement() before any runs: only DROP TABLE IF EXISTS, CREATE TABLE and
// INSERT ... VALUES, on a table named wp_*. Nothing else (no GRANT, SET, LOAD
// DATA, SELECT, INTO OUTFILE, a function in VALUES, a comment, a second
// statement). replace=1 first drops every wp_ table of the database. MySQL
// commits DDL on its own, so a part that fails leaves what ran before it.

const TABLE = '`wp_[A-Za-z0-9_]{1,60}`';
const MODE = "sql_mode='NO_AUTO_VALUE_ON_ZERO'";
const DROP_RE = new RegExp(`^DROP TABLE IF EXISTS ${TABLE}$`);
const CREATE_RE = new RegExp(`^CREATE TABLE ${TABLE} \\(`);
const INSERT_RE = new RegExp(`^(SET STATEMENT ${MODE} FOR )?INSERT (/\\*\\+ SET_VAR\\(${MODE}\\) \\*/ )?INTO ${TABLE} (\\(\`[A-Za-z0-9_]+\`(, ?\`[A-Za-z0-9_]+\`)*\\) )?VALUES `);
const TABLE_OPTIONS = new Set(['ENGINE', 'DEFAULT', 'CHARSET', 'CHARACTER', 'SET', 'COLLATE', 'AUTO_INCREMENT', 'ROW_FORMAT', 'COMMENT', 'STATS_PERSISTENT', 'PACK_KEYS', 'KEY_BLOCK_SIZE', 'AVG_ROW_LENGTH']);

// Split SQL into the parts outside string literals: [{text, depth}] runs of
// code with the parenthesis depth at their start, plus the strings. Single
// and double quoted strings may use backslash escapes (mode is fixed per
// INSERT by its hint) or doubled quotes. Backticked names are code.
function scan(sql, { backslash }) {
	const code = [];
	const strings = [];
	let depth = 0;
	let buf = '';
	let bufDepth = 0;
	let maxGroups = 0;
	for (let i = 0; i < sql.length; i++) {
		const c = sql[i];
		if (c === "'" || c === '"') {
			if (buf) code.push({ text: buf, depth: bufDepth }), (buf = '');
			let j = i + 1;
			let s = '';
			for (;;) {
				if (j >= sql.length) return { error: 'a string does not end' };
				const d = sql[j];
				if (d === '\\') {
					if (!backslash) return { error: 'a backslash in a string (not allowed in this statement)' };
					s += sql[j + 1] === undefined ? '' : sql[j + 1];
					j += 2;
					continue;
				}
				if (d === c) {
					if (sql[j + 1] === c) {
						s += c;
						j += 2;
						continue;
					}
					break;
				}
				s += d;
				j++;
			}
			strings.push({ quote: c, depth, value: s });
			i = j;
			bufDepth = depth;
			continue;
		}
		if (c === '`') {
			const j = sql.indexOf('`', i + 1);
			if (j < 0) return { error: 'a name does not end' };
			buf += sql.slice(i, j + 1);
			i = j;
			continue;
		}
		if (c === '(') {
			if (depth === 0) maxGroups++;
			depth++;
		} else if (c === ')') {
			depth--;
			if (depth < 0) return { error: 'unbalanced parentheses' };
		}
		if (!buf) bufDepth = depth;
		buf += c;
	}
	if (buf) code.push({ text: buf, depth: bufDepth });
	if (depth !== 0) return { error: 'unbalanced parentheses' };
	return { code: code.map((x) => x.text).join(' '), parts: code, strings, groups: maxGroups };
}

// null when the statement may run, else the reason it may not.
export function checkStatement(sql) {
	if (typeof sql !== 'string' || !sql) return 'not a statement';
	if (sql.endsWith(';')) sql = sql.slice(0, -1);
	if (/[\u0000]/.test(sql)) return 'a NUL byte';
	if (DROP_RE.test(sql)) return null;
	const create = CREATE_RE.test(sql);
	const insert = sql.match(INSERT_RE);
	if (!create && !insert) return 'not DROP TABLE IF EXISTS, CREATE TABLE or INSERT ... VALUES on a wp_ table';
	// CREATE: no backslash and no double quote in its strings, so the server
	// reads them the same way in every sql_mode (NO_BACKSLASH_ESCAPES,
	// ANSI_QUOTES). INSERT: its mode is set by the hint, and backslashes are
	// how mysqldump escapes.
	const rest = create ? sql.slice(sql.indexOf('(')) : sql.slice(insert[0].length);
	const s = scan(rest, { backslash: !!insert });
	if (s.error) return s.error;
	if (/;|\/\*|\*\/|--|#/.test(s.code)) return 'a ; or a comment outside a string';
	if (create) {
		if (s.strings.some((x) => x.quote === '"')) return 'a double-quoted string in CREATE TABLE';
		if (s.groups !== 1) return 'CREATE TABLE has more than one parenthesis group';
		// Column definitions may hold expressions (DEFAULT (...), GENERATED AS):
		// none that reads data, files or time.
		const bad = s.code.replace(/`[^`]*`/g, '``').match(/\b(SELECT|LOAD_FILE|INTO|OUTFILE|DUMPFILE|SLEEP|BENCHMARK|LIKE|AS)\b/i);
		if (bad) return `"${bad[1]}" in CREATE TABLE`;
		// After the column list: table options only, as NAME[=]VALUE.
		const close = matchingParen(rest);
		const tail = scan(rest.slice(close + 1), { backslash: false });
		if (tail.error) return tail.error;
		const words = tail.code.replace(/=/g, ' = ').split(/\s+/).filter(Boolean);
		let expectValue = false;
		for (const w of words) {
			if (w === '=') continue;
			const up = w.toUpperCase();
			if (TABLE_OPTIONS.has(up)) {
				expectValue = !['DEFAULT', 'CHARACTER'].includes(up);
				continue;
			}
			if (expectValue && /^[A-Za-z0-9_]+$/.test(w)) {
				expectValue = false;
				continue;
			}
			return `"${w.slice(0, 40)}" after the column list of CREATE TABLE`;
		}
		return null;
	}
	// INSERT: VALUES (...), (...): commas between the groups at depth 0, and
	// only literals in the groups (numbers, NULL, 0x hex, strings).
	const flat = s.code;
	// Depth-0 code: only "(", ")", commas and spaces.
	let depth = 0;
	let token = '';
	const tokens = [];
	for (const c of flat) {
		if (c === '(' || c === ')' || c === ',' || /\s/.test(c)) {
			if (token) tokens.push({ token, depth }), (token = '');
			if (c === '(') depth++;
			if (c === ')') depth--;
			continue;
		}
		token += c;
	}
	if (token) tokens.push({ token, depth });
	for (const { token: t, depth: d } of tokens) {
		if (d === 0) return `"${t.slice(0, 40)}" between the VALUES groups`;
		if (!/^(NULL|[-+]?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?|0x[0-9A-Fa-f]*)$/i.test(t)) return `"${t.slice(0, 40)}" in VALUES: only literals are allowed`;
	}
	return null;
}

function matchingParen(s) {
	let depth = 0;
	let q = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) {
			if (c === q && s[i + 1] === q) i++;
			else if (c === q) q = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') q = c;
		else if (c === '(') depth++;
		else if (c === ')' && --depth === 0) return i;
	}
	return -1;
}

// A cell as text. mysql-bridge.js returns a column with the binary character
// set (63) as {"$b": base64}: MariaDB reports COUNT(*) and MIN() of an integer
// that way (measured 2026-11-06 on wp-ref-a, 10.11.14; VERSION() came as text),
// so every read here decodes it.
export function cell(v) {
	if (v === null || v === undefined) return null;
	if (typeof v === 'object' && typeof v.$b === 'string') return new TextDecoder().decode(Uint8Array.from(atob(v.$b), (c) => c.charCodeAt(0)));
	return String(v);
}
// An integer cell, or an error: never a NaN that JSON turns into null.
export function int(v, what) {
	const t = cell(v);
	if (t === null || !/^-?[0-9]+$/.test(t)) throw new Error(`${what}: not an integer (${JSON.stringify(v)})`);
	return Number(t);
}

async function one(db, env, sql) {
	const r = await db.query(env, { mysql: sql });
	if (!r.ok) throw new Error(r.error);
	return r;
}

async function wpTables(db, env) {
	const r = await one(db, env, 'SHOW TABLES');
	return (r.rows || []).map((x) => cell(x[0])).filter((t) => /^wp_[A-Za-z0-9_]{1,60}$/.test(t || ''));
}

// max_allowed_packet as the server reports it. Through Vitess a SELECT of a
// system variable can return no row (seen for @@sql_mode, #50), so SHOW
// VARIABLES is tried next. No value: an error, not a guess.
async function packet(db, env) {
	const a = await db.query(env, { mysql: 'SELECT @@max_allowed_packet' });
	if (a.ok && a.rows && a.rows.length && /^[1-9][0-9]*$/.test(cell(a.rows[0][0]) || '')) return { bytes: int(a.rows[0][0], 'max_allowed_packet'), via: 'SELECT @@max_allowed_packet' };
	const b = await db.query(env, { mysql: "SHOW VARIABLES LIKE 'max_allowed_packet'" });
	if (b.ok && b.rows && b.rows.length && /^[1-9][0-9]*$/.test(cell(b.rows[0][1]) || '')) return { bytes: int(b.rows[0][1], 'max_allowed_packet'), via: 'SHOW VARIABLES' };
	return { bytes: null, via: null, error: (a.ok ? 'no row' : a.error) + '; ' + (b.ok ? 'no row' : b.error) };
}

export async function sqlImport(req, env, url, db) {
	if (!db) return new Response('/_sqlimport is for variant a only (MySQL through Hyperdrive)', { status: 404 });
	if (!env.SPIKE_TOKEN || req.headers.get('x-spike-token') !== env.SPIKE_TOKEN) return new Response('forbidden', { status: 403 });
	const json = (o, status = 200) => Response.json(o, { status, headers: { 'cache-control': 'private, no-store' } });
	try {
		if (req.method === 'GET' && url.searchParams.get('info') === '1') {
			const v = await one(db, env, 'SELECT VERSION()');
			const version = String(v.rows && v.rows[0] && cell(v.rows[0][0]));
			const p = await packet(db, env);
			return json({ version, flavour: /mariadb/i.test(version) ? 'mariadb' : 'mysql', max_allowed_packet: p.bytes, packet_via: p.via, packet_error: p.error });
		}
		if (req.method === 'GET' && url.searchParams.get('counts') === '1') {
			const tables = {};
			for (const t of await wpTables(db, env)) {
				const n = await one(db, env, `SELECT COUNT(*) FROM \`${t}\``);
				let min_pk = null;
				const col = await db.query(env, { mysql: `SHOW COLUMNS FROM \`${t}\` WHERE Extra LIKE '%auto_increment%'` });
				const pk = col.ok && col.rows && col.rows.length ? cell(col.rows[0][0]) : null;
				if (pk && /^[A-Za-z0-9_]+$/.test(pk)) {
					const m = await one(db, env, `SELECT MIN(\`${pk}\`) FROM \`${t}\``);
					// NULL only for an empty table.
					min_pk = m.rows[0][0] === null ? null : int(m.rows[0][0], `MIN(${pk}) of ${t}`);
				}
				tables[t] = { rows: int(n.rows[0][0], `COUNT(*) of ${t}`), min_pk };
			}
			return json({ tables });
		}
		if (req.method !== 'POST') return new Response('GET ?info=1, GET ?counts=1, or POST', { status: 405 });
		const lines = (await req.text()).split('\n').filter((l) => l.trim());
		const sqls = [];
		for (let i = 0; i < lines.length; i++) {
			let o;
			try {
				o = JSON.parse(lines[i]);
			} catch {
				return json({ ok: false, line: i + 1, error: 'not JSON' }, 400);
			}
			const why = checkStatement(o.sql);
			if (why) return json({ ok: false, line: i + 1, error: 'refused: ' + why, ran: 0 }, 400);
			sqls.push(o.sql);
		}
		let dropped = 0;
		if (url.searchParams.get('replace') === '1') {
			for (const t of await wpTables(db, env)) {
				await one(db, env, `DROP TABLE IF EXISTS \`${t}\``);
				dropped++;
			}
		}
		for (let i = 0; i < sqls.length; i++) {
			const r = await db.query(env, { mysql: sqls[i] });
			if (!r.ok) return json({ ok: false, line: i + 1, ran: i, dropped, error: r.error, errno: r.errno }, 400);
		}
		return json({ ok: true, statements: sqls.length, dropped });
	} catch (e) {
		return json({ ok: false, error: String((e && e.message) || e) }, 500);
	}
}
