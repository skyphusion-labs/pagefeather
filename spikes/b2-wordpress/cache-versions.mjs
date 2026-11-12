// Exact cross-isolate object-cache invalidation for approach A (#296, slice 1).
//
// One small table per site, <prefix>skyph_cache_versions (grp, v), holds a version per cache
// group. AFTER INSERT / UPDATE / DELETE triggers on <prefix>posts, <prefix>postmeta and
// <prefix>options bump the matching group IN THE SAME STATEMENT as the write (one commit, so the
// version can never move before or after its data). The options triggers skip _transient_% and
// _site_transient_% rows. The object cache (php/object-cache-js.php) reads the versions once per
// request and uses each version as its group's salt, so a bump changes every key of that group in
// every isolate's L1 and in L2 at once. Measured on Hyperdrive/Azure 2026-11-12 (#296): a trigger
// adds about 0 ms to a write; the standalone versions read is one round trip.
//
// Capability detection (the lead's ruling): a provider that cannot create triggers (PlanetScale /
// Vitess has none) gets NO versions table, so the cache keeps its unversioned posture there. The
// appended-bump fallback for such providers is a later slice.
//
// Pure: every function takes q(sql) -> { ok, rows?, error?, errno? } (the dbHandler reply shape),
// so a test drives it with a fake.

export const GROUPS = [
	{ table: 'posts', grp: 'posts' },
	{ table: 'postmeta', grp: 'post_meta' },
	{ table: 'options', grp: 'options' },
];
const EVENTS = [['INSERT', 'ai', 'NEW'], ['UPDATE', 'au', 'NEW'], ['DELETE', 'ad', 'OLD']];

export function validPrefix(prefix) {
	return typeof prefix === 'string' && /^[A-Za-z0-9_]{1,20}$/.test(prefix);
}
export function versionsTable(prefix) { return `${prefix}skyph_cache_versions`; }
export function triggerNames(prefix) {
	return GROUPS.flatMap(({ table }) => EVENTS.map(([, ab]) => `${prefix}skyph_v_${table}_${ab}`));
}

// The CREATE TRIGGER statements. Each is ONE statement (Hyperdrive refuses multi-statement SQL).
export function triggerSql(prefix) {
	const vt = versionsTable(prefix);
	const out = [];
	for (const { table, grp } of GROUPS) {
		for (const [ev, ab, row] of EVENTS) {
			const bump = `UPDATE ${vt} SET v = v + 1 WHERE grp = '${grp}'`;
			const body = table === 'options'
				? `BEGIN IF ${row}.option_name NOT LIKE '\\_transient\\_%' AND ${row}.option_name NOT LIKE '\\_site\\_transient\\_%' THEN ${bump}; END IF; END`
				: bump;
			out.push({ name: `${prefix}skyph_v_${table}_${ab}`, sql: `CREATE TRIGGER ${prefix}skyph_v_${table}_${ab} AFTER ${ev} ON ${prefix}${table} FOR EACH ROW ${body}` });
		}
	}
	return out;
}

// A cell as the dbHandler sends it: a string, or { $b: base64 } for a binary-charset column, which
// COUNT(*) and the BIGINT version are (mysql-lean-bridge.js). Measured live on pf1112-a 2026-11-12:
// without this the table count read as NaN and status said "no table" for a table that existed.
export function cell(v) {
	if (v && typeof v === 'object' && typeof v.$b === 'string') return new TextDecoder().decode(Uint8Array.from(atob(v.$b), (c) => c.charCodeAt(0)));
	return v;
}
const err = (r) => `${(r && r.errno) || ''} ${(r && r.error) || 'no reply'}`.trim();

export async function status(q, prefix) {
	if (!validPrefix(prefix)) return { ok: false, error: 'bad table prefix' };
	const t = await q(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${versionsTable(prefix)}'`);
	const g = await q(`SELECT trigger_name FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name LIKE '${prefix.replace(/_/g, '\\_')}skyph\\_v\\_%'`);
	if (!t.ok || !g.ok) return { ok: false, error: err(t.ok ? g : t) };
	const table = Number(cell(t.rows[0][0])) > 0;
	let versions = null;
	if (table) {
		const v = await q(`SELECT grp, v FROM ${versionsTable(prefix)}`);
		if (v.ok) versions = Object.fromEntries(v.rows.map(([k, n]) => [cell(k), Number(cell(n))]));
	}
	const triggers = g.rows.map((r) => cell(r[0])).sort();
	return { ok: true, table, triggers, versions, complete: table && triggers.length === triggerNames(prefix).length };
}

export async function remove(q, prefix) {
	if (!validPrefix(prefix)) return { ok: false, error: 'bad table prefix' };
	const errors = [];
	for (const n of triggerNames(prefix)) { const r = await q(`DROP TRIGGER IF EXISTS ${n}`); if (!r.ok) errors.push(`${n}: ${err(r)}`); }
	const r = await q(`DROP TABLE IF EXISTS ${versionsTable(prefix)}`);
	if (!r.ok) errors.push(`${versionsTable(prefix)}: ${err(r)}`);
	const s = await status(q, prefix);
	return { ok: errors.length === 0 && s.ok && !s.table && s.triggers.length === 0, errors, after: s };
}

// Install, all or nothing: the table and its rows, then every trigger. If ANY trigger cannot be
// made, everything is removed again and the site stays unversioned (versioned: false, reason).
export async function install(q, prefix) {
	if (!validPrefix(prefix)) return { ok: false, error: 'bad table prefix' };
	const vt = versionsTable(prefix);
	const steps = [
		`CREATE TABLE IF NOT EXISTS ${vt} (grp VARCHAR(32) NOT NULL PRIMARY KEY, v BIGINT UNSIGNED NOT NULL DEFAULT 0) ENGINE=InnoDB`,
		`INSERT IGNORE INTO ${vt} (grp, v) VALUES ${GROUPS.map(({ grp }) => `('${grp}', 0)`).join(', ')}`,
	];
	for (const s of steps) {
		const r = await q(s);
		if (!r.ok) { await remove(q, prefix); return { ok: true, versioned: false, reason: `the versions table: ${err(r)}` }; }
	}
	for (const t of triggerSql(prefix)) {
		await q(`DROP TRIGGER IF EXISTS ${t.name}`);
		const r = await q(t.sql);
		if (!r.ok) {
			const back = await remove(q, prefix);
			return { ok: true, versioned: false, reason: `the trigger ${t.name}: ${err(r)}`, removed: back.ok };
		}
	}
	const s = await status(q, prefix);
	return { ok: s.ok && s.complete, versioned: s.ok && s.complete, status: s };
}
