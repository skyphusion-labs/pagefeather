// Exact invalidation for the #63 page cache on approach A (#296 step 1). PAGE_CACHE_VERSIONS=on.
//
// #63 keeps a guest page at the edge for PAGE_CACHE_TTL plus stale-while-revalidate, and purges on
// some content hooks (rate-limited). It does not purge when a checkout changes a product, so a
// cached shop or product page can show old stock or price. Here, one counter `pages` in
// <prefix>skyph_page_version is bumped by AFTER triggers IN THE SAME STATEMENT as each write that
// can change a guest page (one commit: the counter never moves before or after its data). The
// gateway reads it once per cacheable request and SETS it on the URL it sends to the cached Pages
// entrypoint (PCV_PARAM), so the cache key moves at every write, in every isolate and colo at once.
// Pages strips the param before WordPress sees it. A failed read is served uncached: exactness
// never falls back to a TTL.
//
// What does not bump (no trigger, or a skip): transients and cron in options; orders, revisions,
// scheduled actions, auto-drafts in posts; edit locks and order meta in postmeta; order notes in
// comments; HPOS order tables, sessions and Action Scheduler tables (no trigger at all).
// A stock change (postmeta _stock on a product) bumps, as it must.
//
// Pure: q(sql) -> { ok, rows?, error?, errno? } (the dbHandler reply shape), so tests drive it with
// a fake. Each SQL is ONE statement: Hyperdrive refuses multi-statement queries (errno 1002, #296).

export const PCV_PARAM = '__pcv';
export const ORDER_TYPES = ['shop_order', 'shop_order_placehold', 'shop_order_refund', 'shop_subscription'];
const POST_SKIP = [...ORDER_TYPES, 'scheduled-action', 'revision', 'customize_changeset', 'oembed_cache'];
const COMMENT_SKIP = ['order_note', 'action_log', 'webhook_delivery'];
const TABLES = ['options', 'posts', 'postmeta', 'comments', 'terms', 'term_taxonomy', 'term_relationships'];
const EVENTS = [['INSERT', 'ai', 'NEW'], ['UPDATE', 'au', 'NEW'], ['DELETE', 'ad', 'OLD']];
const list = (a) => a.map((s) => `'${s}'`).join(', ');

export function validPrefix(prefix) {
	return typeof prefix === 'string' && /^[A-Za-z0-9_]{1,20}$/.test(prefix);
}
export function versionTable(prefix) { return `${prefix}skyph_page_version`; }
// A value inside a LIKE pattern: the backslash (the default escape) first, then % and _.
export function likeEscape(s) { return String(s).replace(/[\\%_]/g, (c) => '\\' + c); }
export function triggerNames(prefix) {
	return TABLES.flatMap((t) => EVENTS.map(([, ab]) => `${prefix}skyph_pv_${t}_${ab}`));
}

// The condition under which a row's write can change a guest page; null means always.
function condition(prefix, table, row) {
	switch (table) {
		case 'options':
			return `${row}.option_name NOT LIKE '\\_transient\\_%' AND ${row}.option_name NOT LIKE '\\_site\\_transient\\_%' AND ${row}.option_name <> 'cron'`;
		case 'posts':
			return `${row}.post_type NOT IN (${list(POST_SKIP)}) AND ${row}.post_status <> 'auto-draft'`;
		case 'postmeta':
			// The parent post's type, by primary key. A meta row of a deleted post reads NULL, which
			// COALESCE turns into a bump (safe side).
			return `${row}.meta_key NOT IN ('_edit_lock', '_edit_last') AND COALESCE((SELECT post_type FROM ${prefix}posts WHERE ID = ${row}.post_id), '') NOT IN (${list(ORDER_TYPES)})`;
		case 'comments':
			return `${row}.comment_type NOT IN (${list(COMMENT_SKIP)})`;
		default:
			return null;
	}
}

export function triggerSql(prefix) {
	const bump = `UPDATE ${versionTable(prefix)} SET v = v + 1 WHERE grp = 'pages'`;
	return TABLES.flatMap((table) => EVENTS.map(([ev, ab, row]) => {
		const c = condition(prefix, table, row);
		const body = c ? `BEGIN IF ${c} THEN ${bump}; END IF; END` : bump;
		const name = `${prefix}skyph_pv_${table}_${ab}`;
		return { name, sql: `CREATE TRIGGER ${name} AFTER ${ev} ON ${prefix}${table} FOR EACH ROW ${body}` };
	}));
}

// A cell as the dbHandler sends it: a string, or { $b: base64 } for a binary-charset column, which
// COUNT(*) and a BIGINT are (mysql-lean-bridge.js; found live on #341, 2026-11-12).
export function cell(v) {
	if (v && typeof v === 'object' && typeof v.$b === 'string') return new TextDecoder().decode(Uint8Array.from(atob(v.$b), (c) => c.charCodeAt(0)));
	return v;
}
const err = (r) => `${(r && r.errno) || ''} ${(r && r.error) || 'no reply'}`.trim();

// The counter, as a string of digits. No table, no row or anything else is a failure: a missing
// counter must never read as version 0, or two states of the site would share one key.
export async function readPageVersion(q, prefix) {
	if (!validPrefix(prefix)) return { ok: false, error: 'bad table prefix' };
	const r = await q(`SELECT v FROM ${versionTable(prefix)} WHERE grp = 'pages'`);
	if (!r || !r.ok) return { ok: false, error: err(r) };
	const v = r.rows && r.rows[0] ? String(cell(r.rows[0][0])) : '';
	return /^[0-9]{1,20}$/.test(v) ? { ok: true, v } : { ok: false, error: 'no pages row' };
}

export async function status(q, prefix) {
	if (!validPrefix(prefix)) return { ok: false, error: 'bad table prefix' };
	const t = await q(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${versionTable(prefix)}'`);
	const g = await q(`SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name LIKE '${likeEscape(prefix)}skyph\\_pv\\_%'`);
	if (!t.ok || !g.ok) return { ok: false, error: err(t.ok ? g : t) };
	const table = Number(cell(t.rows[0][0])) > 0;
	const r = table ? await readPageVersion(q, prefix) : { ok: false };
	const triggers = g.rows.map((x) => cell(x[0])).sort();
	return { ok: true, table, triggers, version: r.ok ? Number(r.v) : null, complete: table && r.ok && triggers.length === triggerNames(prefix).length };
}

export async function remove(q, prefix) {
	if (!validPrefix(prefix)) return { ok: false, error: 'bad table prefix' };
	const errors = [];
	for (const n of triggerNames(prefix)) { const r = await q(`DROP TRIGGER IF EXISTS ${n}`); if (!r.ok) errors.push(`${n}: ${err(r)}`); }
	const r = await q(`DROP TABLE IF EXISTS ${versionTable(prefix)}`);
	if (!r.ok) errors.push(`${versionTable(prefix)}: ${err(r)}`);
	const s = await status(q, prefix);
	return { ok: errors.length === 0 && s.ok && !s.table && s.triggers.length === 0, errors, after: s };
}

// All or nothing: the table and its row, then every trigger. If ANY step fails, everything is
// removed again (versioned: false, reason), so a site is never half-versioned.
export async function install(q, prefix) {
	if (!validPrefix(prefix)) return { ok: false, error: 'bad table prefix' };
	const vt = versionTable(prefix);
	for (const s of [
		`CREATE TABLE IF NOT EXISTS ${vt} (grp VARCHAR(32) NOT NULL PRIMARY KEY, v BIGINT UNSIGNED NOT NULL DEFAULT 0) ENGINE=InnoDB`,
		`INSERT IGNORE INTO ${vt} (grp, v) VALUES ('pages', 0)`,
	]) {
		const r = await q(s);
		if (!r.ok) { const back = await remove(q, prefix); return { ok: true, versioned: false, reason: `the version table: ${err(r)}`, removed: back.ok }; }
	}
	for (const t of triggerSql(prefix)) {
		await q(`DROP TRIGGER IF EXISTS ${t.name}`);
		const r = await q(t.sql);
		if (!r.ok) { const back = await remove(q, prefix); return { ok: true, versioned: false, reason: `the trigger ${t.name}: ${err(r)}`, removed: back.ok }; }
	}
	const s = await status(q, prefix);
	return { ok: s.ok && s.complete, versioned: s.ok && s.complete, status: s };
}

// The URL the gateway sends to Pages: the param is SET, so a client cannot pin another key.
export function versionedUrl(url, v) {
	const u = new URL(url);
	u.searchParams.set(PCV_PARAM, v);
	return u.toString();
}

// The request WordPress sees: the param removed, everything else as it came.
export function stripPcv(req) {
	const u = new URL(req.url);
	if (!u.searchParams.has(PCV_PARAM)) return req;
	u.searchParams.delete(PCV_PARAM);
	return new Request(u.toString(), req);
}

// On only with the flag, on approach A's external MySQL, with a handler that can run one query on
// its own connection (oneShot: the gateway must not share a connection with a request it calls).
export function pageVersionsOn(env, handler) {
	return env.PAGE_CACHE_VERSIONS === 'on' && env.DB_IN_DO !== 'on' && !!(handler && typeof handler.oneShot === 'function');
}
