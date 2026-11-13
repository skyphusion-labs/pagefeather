// Plugins and themes installed from wp-admin persist (issue #407, design
// docs/design-407-plugin-persistence.md). The site's own R2 bucket holds each installed plugin or
// theme as one zip, content-addressed by its SHA-256; an INDEX records which zips are installed.
// The index is an adapter, so both engines use the same logic:
//   - b-dosql: sqliteIndex(ctx.storage.sql, transactionSync), the object's own SQLite;
//   - approach a (Hyperdrive MySQL, Conrad 2026-11-13: that path stays open): mysqlIndex(run), two
//     tables in the site's MySQL, through the same bridge WordPress uses.
// The MySQL adapter's SQL is the subset MySQL and SQLite both accept, so the test suite runs the
// whole logic against both adapters on a real SQLite (tests/code-store.test.mjs).
//
// Order of writes, so a crash at any point leaves a state boot can handle:
//   put:    object (by sha) FIRST, then the row and the generation in one transaction.
//           A crash between them leaves an orphan object: never loaded, swept later.
//   delete: the row and the generation FIRST, then the object.
// Boot loads only rows, and refuses a row whose object is missing or whose bytes do not match the
// sha256 in its key: a changed or truncated object is never run.

export const CODE_PREFIX = '_code/';
const TYPES = new Set(['plugin', 'theme']);
const MIB = 1048576;

// A size an admin reads: KB under 1 MB, else MB with one decimal.
export function humanSize(bytes) {
	const n = Math.max(0, Number(bytes) || 0);
	return n < MIB ? `${Math.ceil(n / 1024)} KB` : `${(n / MIB).toFixed(1)} MB`;
}
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
// A version string as stored: the characters a plugin header uses, nothing a SQL literal could misread.
export function cleanVersion(v) {
	return v === null || v === undefined ? null : String(v).replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 64) || null;
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

const COLS = 'ctype, slug, version, obj_key, sha256, bytes, files, updated_at';
const DDL_CODE = 'CREATE TABLE IF NOT EXISTS pf_code (ctype VARCHAR(16) NOT NULL, slug VARCHAR(100) NOT NULL, version VARCHAR(64), obj_key VARCHAR(255) NOT NULL, sha256 CHAR(64) NOT NULL, bytes BIGINT NOT NULL, files INTEGER NOT NULL, updated_at BIGINT NOT NULL, PRIMARY KEY (ctype, slug))';
const DDL_STATE = 'CREATE TABLE IF NOT EXISTS pf_code_state (id INTEGER NOT NULL PRIMARY KEY, gen BIGINT NOT NULL, last_sweep BIGINT NOT NULL)';
const rowFrom = (r) => ({ type: r.ctype, slug: r.slug, version: r.version, key: r.obj_key, sha256: r.sha256, bytes: Number(r.bytes), files: Number(r.files), updated_at: Number(r.updated_at) });

/** b-dosql: the object's own SQLite (ctx.storage.sql), transactions through transactionSync. */
export function sqliteIndex(sql, txn) {
	let ready = false;
	const ensure = () => {
		if (ready) return;
		sql.exec(DDL_CODE);
		sql.exec(DDL_STATE);
		sql.exec('INSERT OR IGNORE INTO pf_code_state (id, gen, last_sweep) VALUES (1, 0, 0)');
		ready = true;
	};
	const all = (q, ...p) => sql.exec(q, ...p).toArray();
	return {
		async rows() {
			ensure();
			return all(`SELECT ${COLS} FROM pf_code ORDER BY ctype, slug`).map(rowFrom);
		},
		async row(type, slug) {
			ensure();
			const r = all(`SELECT ${COLS} FROM pf_code WHERE ctype = ? AND slug = ?`, type, slug)[0];
			return r ? rowFrom(r) : null;
		},
		async gen() {
			ensure();
			return Number(all('SELECT gen FROM pf_code_state WHERE id = 1')[0].gen);
		},
		async othersBytes(type, slug) {
			ensure();
			return Number(all('SELECT COALESCE(SUM(bytes), 0) AS n FROM pf_code WHERE NOT (ctype = ? AND slug = ?)', type, slug)[0].n);
		},
		async upsert(r) {
			ensure();
			txn(() => {
				sql.exec('DELETE FROM pf_code WHERE ctype = ? AND slug = ?', r.type, r.slug);
				sql.exec(`INSERT INTO pf_code (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, r.type, r.slug, r.version, r.key, r.sha256, r.bytes, r.files, r.updated_at);
				sql.exec('UPDATE pf_code_state SET gen = gen + 1 WHERE id = 1');
			});
		},
		async remove(type, slug) {
			ensure();
			txn(() => {
				sql.exec('DELETE FROM pf_code WHERE ctype = ? AND slug = ?', type, slug);
				sql.exec('UPDATE pf_code_state SET gen = gen + 1 WHERE id = 1');
			});
		},
		async lastSweep() {
			ensure();
			return Number(all('SELECT last_sweep FROM pf_code_state WHERE id = 1')[0].last_sweep);
		},
		async markSweep(now) {
			ensure();
			sql.exec('UPDATE pf_code_state SET last_sweep = ? WHERE id = 1', now);
		},
	};
}

/**
 * Approach a: two tables in the site's MySQL. run(sql) sends ONE literal statement on the request's
 * connection and resolves { ok, columns, rows } (rows as arrays, as mysql-*-bridge.js answer) or
 * { ok: false, error }. Every value is validated or an integer before it becomes a literal, and
 * the strings are quoted with lit() below (no backslash or quote can reach it).
 */
export function mysqlIndex(run) {
	const lit = (s) => {
		if (s === null || s === undefined) return 'NULL';
		const v = String(s);
		if (!/^[A-Za-z0-9._+\/-]*$/.test(v)) throw new Error('a value that is not safe as a literal');
		return `'${v}'`;
	};
	const int = (n) => {
		const v = Math.trunc(Number(n));
		if (!Number.isFinite(v)) throw new Error('not an integer');
		return String(v);
	};
	const q = async (sql) => {
		const r = await run(sql);
		if (!r || !r.ok) throw new Error((r && r.error) || 'the database did not answer');
		return (r.rows || []).map((row) => Object.fromEntries((r.columns || []).map((c, i) => [c, row[i]])));
	};
	let ready = false;
	const ensure = async () => {
		if (ready) return;
		await q(DDL_CODE);
		await q(DDL_STATE);
		if (!(await q('SELECT id FROM pf_code_state WHERE id = 1')).length) {
			try {
				await q('INSERT INTO pf_code_state (id, gen, last_sweep) VALUES (1, 0, 0)');
			} catch (e) {
				// Another isolate made it first (a duplicate key): the row exists, which is all we need.
				if (!(await q('SELECT id FROM pf_code_state WHERE id = 1')).length) throw e;
			}
		}
		ready = true;
	};
	const txn = async (stmts) => {
		await q('BEGIN');
		try {
			for (const s of stmts) await q(s);
			await q('COMMIT');
		} catch (e) {
			try {
				await q('ROLLBACK');
			} catch {
				// The connection is gone; the server rolls back an unfinished transaction.
			}
			throw e;
		}
	};
	return {
		async rows() {
			await ensure();
			return (await q(`SELECT ${COLS} FROM pf_code ORDER BY ctype, slug`)).map(rowFrom);
		},
		async row(type, slug) {
			await ensure();
			const r = (await q(`SELECT ${COLS} FROM pf_code WHERE ctype = ${lit(type)} AND slug = ${lit(slug)}`))[0];
			return r ? rowFrom(r) : null;
		},
		async gen() {
			await ensure();
			return Number((await q('SELECT gen FROM pf_code_state WHERE id = 1'))[0].gen);
		},
		async othersBytes(type, slug) {
			await ensure();
			return Number((await q(`SELECT COALESCE(SUM(bytes), 0) AS n FROM pf_code WHERE NOT (ctype = ${lit(type)} AND slug = ${lit(slug)})`))[0].n);
		},
		async upsert(r) {
			await ensure();
			await txn([
				`DELETE FROM pf_code WHERE ctype = ${lit(r.type)} AND slug = ${lit(r.slug)}`,
				`INSERT INTO pf_code (${COLS}) VALUES (${lit(r.type)}, ${lit(r.slug)}, ${lit(r.version)}, ${lit(r.key)}, ${lit(r.sha256)}, ${int(r.bytes)}, ${int(r.files)}, ${int(r.updated_at)})`,
				'UPDATE pf_code_state SET gen = gen + 1 WHERE id = 1',
			]);
		},
		async remove(type, slug) {
			await ensure();
			await txn([`DELETE FROM pf_code WHERE ctype = ${lit(type)} AND slug = ${lit(slug)}`, 'UPDATE pf_code_state SET gen = gen + 1 WHERE id = 1']);
		},
		async lastSweep() {
			await ensure();
			return Number((await q('SELECT last_sweep FROM pf_code_state WHERE id = 1'))[0].last_sweep);
		},
		async markSweep(now) {
			await ensure();
			await q(`UPDATE pf_code_state SET last_sweep = ${int(now)} WHERE id = 1`);
		},
	};
}

/**
 * Persist one installed plugin or theme. zip is the deflated zip of its directory (entry names
 * relative to the directory). Returns { ok: true, key, sha256, gen } or { ok: false, code, error }
 * in plain words.
 */
export async function putCode({ index, bucket, type, slug, version, zip, files, budget, now }) {
	if (!validType(type) || !validSlug(slug)) return { ok: false, code: 'bad-name', error: `"${slug}" is not a ${type} name this site can store.` };
	if (budget === null || budget === undefined) return { ok: false, code: 'no-budget', error: 'Installs are not stored on this site yet: its installed-code budget (CODE_BUDGET_MB) is not set.' };
	let others, old;
	try {
		others = await index.othersBytes(type, slug);
		old = await index.row(type, slug);
	} catch (e) {
		return { ok: false, code: 'index', error: `${slug} could not be checked against this site's index (${String((e && e.message) || e).slice(0, 120)}). It was not installed.` };
	}
	if (others + zip.length > budget) {
		return { ok: false, code: 'budget', error: `${slug} needs ${humanSize(zip.length)}, and this site has ${humanSize(budget - others)} of room left for installed code. It was not installed.` };
	}
	const sha = await sha256Hex(zip);
	const key = codeKey(type, slug, sha);
	try {
		await bucket.put(key, zip, { sha256: sha });
	} catch (e) {
		return { ok: false, code: 'store', error: `${slug} could not be saved to this site's storage (${String((e && e.message) || e).slice(0, 120)}). It was not installed.` };
	}
	try {
		await index.upsert({ type, slug, version: cleanVersion(version), key, sha256: sha, bytes: zip.length, files: files || 0, updated_at: now });
	} catch (e) {
		// The object is written and no row points at it (#449): delete it now, so a failed install leaves
		// nothing behind. Never when the live row already points at this same content (a reinstall of
		// the same zip): that object is the live install. A delete that fails here is left to the sweep.
		if (!old || old.key !== key) {
			try {
				await bucket.delete(key);
			} catch {
				// an orphan for the sweep; boot never loads it
			}
		}
		return { ok: false, code: 'index', error: `${slug} could not be recorded (${String((e && e.message) || e).slice(0, 120)}). It was not installed.` };
	}
	if (old && old.key !== key) {
		try {
			await bucket.delete(old.key);
		} catch {
			// The old version is an orphan now; the sweep removes it.
		}
	}
	return { ok: true, key, sha256: sha, gen: await index.gen() };
}

/** Forget one plugin or theme: the row and the generation first, then the object. */
export async function deleteCode({ index, bucket, type, slug }) {
	if (!validType(type) || !validSlug(slug)) return { ok: false, code: 'bad-name', error: `"${slug}" is not a ${type} name this site can store.` };
	const row = await index.row(type, slug);
	if (!row) return { ok: true, gen: await index.gen(), none: true };
	await index.remove(type, slug);
	try {
		await bucket.delete(row.key);
	} catch {
		// An orphan now; the sweep removes it. The row is gone, so boot no longer loads it.
	}
	return { ok: true, gen: await index.gen() };
}

/**
 * Every row, fetched and verified. A row whose object is missing, or whose bytes do not match the
 * sha256 and size recorded, is REFUSED (not mounted) with a reason a WordPress admin can act on.
 */
export async function loadCode({ index, bucket }) {
	const rows = await index.rows();
	const gen = await index.gen();
	const got = await Promise.all(
		rows.map(async (r) => {
			let obj;
			try {
				obj = await bucket.get(r.key);
			} catch {
				return { r, err: 'unreadable' };
			}
			if (!obj) return { r, err: 'missing' };
			const zip = new Uint8Array(await obj.arrayBuffer());
			if (zip.length !== r.bytes || (await sha256Hex(zip)) !== r.sha256) return { r, err: 'damaged' };
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
export async function sweepOrphans({ index, bucket, now, graceMs = 10 * 60 * 1000 }) {
	const live = new Set((await index.rows()).map((r) => r.key));
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
	await index.markSweep(now);
	return deleted;
}

/**
 * What one PHP runtime has mounted. sync() compares the stored generation with the one it mounted
 * and, when they differ, mounts what changed: a second runtime (or isolate) sees an install the
 * first one made. mount(type, slug, zip) and unmount(type, slug) act on that runtime's file system.
 * minIntervalMs (approach a: many isolates, and the generation is a MySQL read) skips the check
 * when the last one was more recent; b-dosql checks every request (0).
 */
export class CodeMounter {
	constructor({ minIntervalMs = 0 } = {}) {
		this.gen = -1;
		this.mounted = new Map(); // "type/slug" -> sha256
		this.refused = [];
		this.minIntervalMs = minIntervalMs;
		this.checkedAt = -Infinity;
	}
	async sync({ index, bucket, mount, unmount, now = Date.now() }) {
		if (this.gen !== -1 && now - this.checkedAt < this.minIntervalMs) return { changed: false, skipped: true };
		const gen = await index.gen();
		this.checkedAt = now;
		if (gen === this.gen) return { changed: false };
		const { mounted, refused } = await loadCode({ index, bucket });
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
