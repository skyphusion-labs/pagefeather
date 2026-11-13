// Plugins and themes installed from wp-admin persist (issue #407, design
// docs/design-407-plugin-persistence.md). The site's own R2 bucket holds each installed plugin or
// theme as one zip, content-addressed by its SHA-256; the object's own SQLite indexes them. This
// module is the logic only, with the storage injected, so it is tested against a real SQLite and a
// fake bucket (tests/code-store.test.mjs). index.js wires it to ctx.storage.sql and env.MEDIA.
//
// Order of writes, so a crash at any point leaves a state boot can handle:
//   put:    object (by sha) FIRST, then the row and the generation in one transaction.
//           A crash between them leaves an orphan object: never loaded, swept later.
//   delete: the row and the generation FIRST, then the object.
//           A crash between them leaves an orphan object: swept later.
// Boot loads only rows, and refuses a row whose object is missing or whose bytes do not match the
// sha256 in its key: a changed or truncated object is never run.

export const CODE_PREFIX = '_code/';
const TYPES = new Set(['plugin', 'theme']);
const MIB = 1048576;

/** A plugin or theme directory name WordPress could have made: no path, no dot names. */
export function validSlug(slug) {
	return typeof slug === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(slug) && !slug.includes('..');
}
export function validType(type) {
	return TYPES.has(type);
}
export function codeKey(type, slug, sha) {
	if (!validType(type) || !validSlug(slug) || !/^[0-9a-f]{64}$/.test(sha)) throw new Error('bad code key parts');
	return `${CODE_PREFIX}${type}/${slug}/${sha}.zip`;
}
export async function sha256Hex(bytes) {
	const h = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The installed-code budget in bytes, from CODE_BUDGET_MB. There is NO default: the design sets it
 * from measured headroom (#394), so an unset or bad value returns null and every install is
 * refused with a plain reason, never accepted and then broken.
 */
export function codeBudget(env) {
	const raw = env && env.CODE_BUDGET_MB;
	if (raw === undefined || raw === null || raw === '') return null;
	const mb = Number(raw);
	if (!Number.isFinite(mb) || mb < 0) return null;
	return Math.floor(mb * MIB);
}

export function ensureSchema(sql) {
	sql.exec(
		'CREATE TABLE IF NOT EXISTS _pf_code (type TEXT NOT NULL, slug TEXT NOT NULL, version TEXT, key TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, files INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (type, slug))',
	);
	sql.exec('CREATE TABLE IF NOT EXISTS _pf_code_state (id INTEGER PRIMARY KEY CHECK (id = 1), gen INTEGER NOT NULL, last_sweep INTEGER NOT NULL DEFAULT 0)');
	sql.exec('INSERT OR IGNORE INTO _pf_code_state (id, gen, last_sweep) VALUES (1, 0, 0)');
}
export function readRows(sql) {
	return sql.exec('SELECT type, slug, version, key, sha256, bytes, files, updated_at FROM _pf_code ORDER BY type, slug').toArray();
}
export function readGen(sql) {
	const r = sql.exec('SELECT gen FROM _pf_code_state WHERE id = 1').toArray();
	return r.length ? Number(r[0].gen) : 0;
}
function rowOf(sql, type, slug) {
	return sql.exec('SELECT type, slug, key, sha256, bytes FROM _pf_code WHERE type = ? AND slug = ?', type, slug).toArray()[0] || null;
}

/**
 * Persist one installed plugin or theme. zip is the deflated zip of its directory (entry names
 * relative to the directory). txn(fn) runs fn as one storage transaction (ctx.storage.transactionSync).
 * Returns { ok: true, key, sha256, gen } or { ok: false, code, error } in plain words.
 */
export async function putCode({ sql, txn, bucket, type, slug, version, zip, files, budget, now }) {
	if (!validType(type) || !validSlug(slug)) return { ok: false, code: 'bad-name', error: `"${slug}" is not a ${type} name this site can store.` };
	if (budget === null || budget === undefined) return { ok: false, code: 'no-budget', error: 'Installs are not stored on this site yet: its installed-code budget (CODE_BUDGET_MB) is not set.' };
	ensureSchema(sql);
	const others = sql.exec('SELECT COALESCE(SUM(bytes), 0) AS n FROM _pf_code WHERE NOT (type = ? AND slug = ?)', type, slug).toArray()[0].n;
	if (Number(others) + zip.length > budget) {
		return {
			ok: false,
			code: 'budget',
			error: `${slug} needs ${(zip.length / MIB).toFixed(1)} MB, and this site has ${(Math.max(0, budget - Number(others)) / MIB).toFixed(1)} MB of room left for installed code. It was not installed.`,
		};
	}
	const sha = await sha256Hex(zip);
	const key = codeKey(type, slug, sha);
	const old = rowOf(sql, type, slug);
	try {
		await bucket.put(key, zip, { sha256: sha });
	} catch (e) {
		return { ok: false, code: 'store', error: `${slug} could not be saved to this site's storage (${String((e && e.message) || e).slice(0, 120)}). It was not installed.` };
	}
	let gen;
	try {
		txn(() => {
			sql.exec(
				'INSERT INTO _pf_code (type, slug, version, key, sha256, bytes, files, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (type, slug) DO UPDATE SET version = excluded.version, key = excluded.key, sha256 = excluded.sha256, bytes = excluded.bytes, files = excluded.files, updated_at = excluded.updated_at',
				type, slug, version || null, key, sha, zip.length, files || 0, now,
			);
			sql.exec('UPDATE _pf_code_state SET gen = gen + 1 WHERE id = 1');
		});
		gen = readGen(sql);
	} catch (e) {
		// The object is written and no row points at it: an orphan the sweep removes. Boot never loads it.
		return { ok: false, code: 'index', error: `${slug} could not be recorded (${String((e && e.message) || e).slice(0, 120)}). It was not installed.` };
	}
	if (old && old.key !== key) {
		try {
			await bucket.delete(old.key);
		} catch {
			// The old version is an orphan now; the sweep removes it.
		}
	}
	return { ok: true, key, sha256: sha, gen };
}

/** Forget one plugin or theme: the row and the generation first, then the object. */
export async function deleteCode({ sql, txn, bucket, type, slug }) {
	if (!validType(type) || !validSlug(slug)) return { ok: false, code: 'bad-name', error: `"${slug}" is not a ${type} name this site can store.` };
	ensureSchema(sql);
	const row = rowOf(sql, type, slug);
	if (!row) return { ok: true, gen: readGen(sql), none: true };
	txn(() => {
		sql.exec('DELETE FROM _pf_code WHERE type = ? AND slug = ?', type, slug);
		sql.exec('UPDATE _pf_code_state SET gen = gen + 1 WHERE id = 1');
	});
	try {
		await bucket.delete(row.key);
	} catch {
		// An orphan now; the sweep removes it. The row is gone, so boot no longer loads it.
	}
	return { ok: true, gen: readGen(sql) };
}

/**
 * Every row, fetched and verified. A row whose object is missing, or whose bytes do not match the
 * sha256 and size recorded, is REFUSED (not mounted) with a reason a WordPress admin can act on.
 */
export async function loadCode({ sql, bucket }) {
	ensureSchema(sql);
	const rows = readRows(sql);
	const gen = readGen(sql);
	const got = await Promise.all(
		rows.map(async (r) => {
			let obj;
			try {
				obj = await bucket.get(r.key);
			} catch (e) {
				return { r, err: 'unreadable' };
			}
			if (!obj) return { r, err: 'missing' };
			const zip = new Uint8Array(await obj.arrayBuffer());
			if (zip.length !== Number(r.bytes) || (await sha256Hex(zip)) !== r.sha256) return { r, err: 'damaged' };
			return { r, zip };
		}),
	);
	const mounted = [];
	const refused = [];
	for (const g of got) {
		if (g.zip) mounted.push({ type: g.r.type, slug: g.r.slug, sha256: g.r.sha256, zip: g.zip });
		else refused.push({ type: g.r.type, slug: g.r.slug, reason: g.err });
	}
	return { gen, mounted, refused };
}

/**
 * Delete objects under _code/ that no row points at, older than graceMs (so an install whose row is
 * still being written is never swept). Returns the keys deleted.
 */
export async function sweepOrphans({ sql, bucket, now, graceMs = 10 * 60 * 1000 }) {
	ensureSchema(sql);
	const live = new Set(readRows(sql).map((r) => r.key));
	const deleted = [];
	let cursor;
	do {
		const page = await bucket.list({ prefix: CODE_PREFIX, cursor });
		for (const o of page.objects) {
			const at = o.uploaded instanceof Date ? o.uploaded.getTime() : Number(o.uploaded || 0);
			if (!live.has(o.key) && at < now - graceMs) {
				await bucket.delete(o.key);
				deleted.push(o.key);
			}
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	sql.exec('UPDATE _pf_code_state SET last_sweep = ? WHERE id = 1', now);
	return deleted;
}

/**
 * What one PHP runtime has mounted. sync() compares the stored generation with the one it mounted
 * and, when they differ, mounts what changed: a second runtime (or isolate) sees an install the
 * first one made. mount(type, slug, zip) and unmount(type, slug) act on that runtime's file system.
 */
export class CodeMounter {
	constructor() {
		this.gen = -1;
		this.mounted = new Map(); // "type/slug" -> sha256
		this.refused = [];
	}
	async sync({ sql, bucket, mount, unmount }) {
		ensureSchema(sql);
		const gen = readGen(sql);
		if (gen === this.gen) return { changed: false };
		const { mounted, refused } = await loadCode({ sql, bucket });
		const want = new Map(mounted.map((m) => [`${m.type}/${m.slug}`, m]));
		for (const [k] of this.mounted) {
			if (!want.has(k)) {
				const [type, slug] = k.split('/');
				unmount(type, slug);
				this.mounted.delete(k);
			}
		}
		for (const [k, m] of want) {
			if (this.mounted.get(k) !== m.sha256) {
				mount(m.type, m.slug, m.zip);
				this.mounted.set(k, m.sha256);
			}
		}
		for (const r of refused) {
			const k = `${r.type}/${r.slug}`;
			if (this.mounted.has(k)) {
				unmount(r.type, r.slug);
				this.mounted.delete(k);
			}
		}
		this.refused = refused;
		this.gen = gen;
		return { changed: true, refused };
	}
	/** The runtime that just stored a zip mounts it lazily from those bytes, and is current. */
	adopt({ type, slug, sha256, zip, gen, mount }) {
		mount(type, slug, zip);
		this.mounted.set(`${type}/${slug}`, sha256);
		if (gen === this.gen + 1) this.gen = gen;
	}
	/** The runtime that just deleted a plugin or theme unmounts it, and is current. */
	forget({ type, slug, gen, unmount }) {
		unmount(type, slug);
		this.mounted.delete(`${type}/${slug}`);
		if (gen === this.gen + 1) this.gen = gen;
	}
}
