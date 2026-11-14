// /_mysqlexport (#479 M2): a ROWS-ONLY, paged export of one table of a b-dosql site's SQLite,
// for moving a store to a Hyperdrive store. Raw SQLite (no PHP boot), read only. The target gets
// its tables from its own native install (#479 M1), so no DDL is exported.
//
// Operator-only: index.js answers every /_ path with 403 unless the spike token is valid, in the
// Worker and again in the object.
//
// A page is `SELECT rowid, * FROM t WHERE rowid > after ORDER BY rowid LIMIT n`. Every table the
// driver makes is a rowid table (STRICT, no WITHOUT ROWID; pf504z, 2026-11-14), so rowid pages a
// composite primary key too. `stats` gives COUNT(*) and MAX(rowid) per table, so a caller can
// prove an export complete: the pages' rows must add up to the count taken before AND after, and
// the last rowid must reach MAX(rowid). Reads on b-dosql can miss existing rows (#519), so a
// shortfall is a FAILED export, never a partial success. That check is the caller's.

export const EXPORT_DEFAULT_LIMIT = 500;
export const EXPORT_MAX_LIMIT = 2000;
const SKIP = /^(sqlite_|_cf_|_wp_undo)/;

export class ExportError extends Error {}

export function quoteIdent(name) {
	return '"' + String(name).replace(/"/g, '""') + '"';
}

function b64(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(s);
}

// A blob cannot go in JSON: it is sent as {$b: base64}, as /_dbexport does.
function jsonRow(row) {
	return row.map((v) => {
		if (v instanceof ArrayBuffer) return { $b: b64(new Uint8Array(v)) };
		if (ArrayBuffer.isView(v)) return { $b: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
		return v;
	});
}

// q(sql, ...bindings) -> { columns: [...], rows: [[...], ...] }
export function exportTables(q) {
	return q("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").rows.map((r) => r[0]).filter((n) => typeof n === 'string' && !SKIP.test(n));
}

export function exportStats(q) {
	const tables = {};
	for (const t of exportTables(q)) {
		const r = q(`SELECT COUNT(*), MAX(rowid) FROM ${quoteIdent(t)}`).rows[0];
		tables[t] = { rows: Number(r[0]), maxRowid: r[1] === null ? 0 : Number(r[1]) };
	}
	return { tables };
}

function intParam(v, def, min, max, what) {
	if (v === null || v === undefined || v === '') return def;
	if (!/^\d{1,16}$/.test(String(v))) throw new ExportError(`${what} must be a whole number`);
	const n = Number(v);
	if (n < min || n > max) throw new ExportError(`${what} must be from ${min} to ${max}`);
	return n;
}

export function exportPage(q, { table, after, limit } = {}) {
	if (!exportTables(q).includes(table)) throw new ExportError('no such table');
	const a = intParam(after, 0, 0, Number.MAX_SAFE_INTEGER, 'after');
	const n = intParam(limit, EXPORT_DEFAULT_LIMIT, 1, EXPORT_MAX_LIMIT, 'limit');
	const r = q(`SELECT rowid AS "__rowid", * FROM ${quoteIdent(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`, a, n);
	const rows = r.rows.map((row) => jsonRow(row.slice(1)));
	const last = r.rows.length ? Number(r.rows[r.rows.length - 1][0]) : a;
	return { table, columns: r.columns.slice(1), after: a, last, n: rows.length, done: rows.length < n, rows };
}

// The request: GET /_mysqlexport?stats=1, or ?table=&after=&limit=.
export function exportRequest(q, url) {
	try {
		const body = url.searchParams.get('stats') === '1'
			? exportStats(q)
			: exportPage(q, { table: url.searchParams.get('table'), after: url.searchParams.get('after'), limit: url.searchParams.get('limit') });
		return Response.json(body, { headers: { 'cache-control': 'private, no-store' } });
	} catch (e) {
		if (e instanceof ExportError) return Response.json({ ok: false, error: e.message }, { status: 400, headers: { 'cache-control': 'private, no-store' } });
		throw e;
	}
}
