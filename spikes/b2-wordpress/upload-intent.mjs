// #1039, approach A (Hyperdrive). PHP autocommits each statement, and a 1102 kill runs no Worker code
// after it, so nothing can delete on rollback (that path is b-dosql, #1047). Instead, the lead's ruling
// (2026-11-22):
//   - before each put or copy that CREATES a key, write `_pf-intent/<key>` whose body is the request id
//     and the time. An overwrite gets no marker. A marker write that fails is a could-not-mark line and
//     does not fail the upload (that file then cannot be swept);
//   - when PHP answers, any status, the request deletes the markers of its own keys in waitUntil;
//   - the sweep judges markers older than 15 minutes, at most SWEEP_MAX per run. One indexed SELECT
//     (meta_key equality, the postmeta index) asks whether an attachment names the file. Attached: drop
//     the marker. Not attached: delete the file, its name reservation and the marker. Any SELECT error
//     keeps both.
// A key that is not under uploads/ is never deleted: the attachment SELECT cannot name it (an invoice,
// an export). Its stale marker is dropped so it does not fill the cap, and the file stays.
export const MARKER_PREFIX = '_pf-intent/';
export const STALE_MS = 15 * 60 * 1000;
export const SWEEP_MAX = 200; // markers per run (the next run takes the rest)
const META_CAP = 40; // metadata rows read for one basename; a full cap that does not match is "could not tell"

/** The REST route a request names, or null (pretty /wp-json/... or ?rest_route=). */
function restRoute(pathname, search) {
	const q = String(search || '');
	const m = /(?:^|[?&])rest_route=([^&]*)/.exec(q);
	if (m) {
		try {
			return decodeURIComponent(m[1].replace(/\+/g, ' '));
		} catch {
			return null;
		}
	}
	const p = String(pathname || '');
	const at = p.indexOf('/wp-json');
	if (at < 0) return null;
	return p.slice(at + '/wp-json'.length) || '/';
}

/** A request that starts a media upload: async-upload.php, media-new.php, media-upload.php, REST POST /wp/v2/media. The sweep trigger, not the set of keys that get a marker. */
export function isMediaUploadRequest(method, pathname, search) {
	if (String(method || '').toUpperCase() !== 'POST') return false;
	if (/\/wp-admin\/(?:async-upload|media-new|media-upload)\.php$/.test(String(pathname || ''))) return true;
	const r = restRoute(pathname, search);
	return r !== null && /^\/wp\/v2\/media\/?$/.test(r);
}

export function markerKey(key) {
	return MARKER_PREFIX + String(key);
}

/** Every file name WordPress's attachment metadata names: file (its basename), each size, original_image. */
export function metadataNames(serialized) {
	const s = typeof serialized === 'string' ? serialized : '';
	const out = new Set();
	// s:N:"file";s:M:"<value>";  and  s:14:"original_image";s:M:"<value>";
	const re = /s:\d+:"(file|original_image)";s:\d+:"([^"]*)";/g;
	let m;
	while ((m = re.exec(s))) {
		const v = m[2];
		out.add(v.includes('/') ? v.slice(v.lastIndexOf('/') + 1) : v);
	}
	return [...out];
}

/** Directory of the metadata's own file path, or null when the blob has no file field. */
function metadataDir(serialized) {
	const m = /s:\d+:"file";s:\d+:"([^"]*)";/.exec(String(serialized || ''));
	if (!m) return null;
	const v = m[1];
	return v.includes('/') ? v.slice(0, v.lastIndexOf('/')) : '';
}

const hex = (s) => "CONVERT(X'" + [...new TextEncoder().encode(String(s))].map((b) => b.toString(16).padStart(2, '0')).join('') + "' USING utf8mb4)";

/**
 * One indexed SELECT that says whether an attachment names an uploads/ key, or null for any other key.
 * Both branches lead with meta_key equality (KEY meta_key on postmeta). Only hex literals carry the
 * name, so a file name is never SQL text. The metadata branch is widened by LIKE and then checked
 * exactly (metadataNames plus the same directory).
 */
export function referenceQuery(prefix, key) {
	const k = String(key);
	if (!k.startsWith('uploads/')) return null;
	const rel = k.slice('uploads/'.length);
	const slash = rel.lastIndexOf('/');
	const dir = slash < 0 ? '' : rel.slice(0, slash);
	const base = slash < 0 ? rel : rel.slice(slash + 1);
	const p = String(prefix || 'wp_').replace(/[^A-Za-z0-9_]/g, '');
	const attached = `(SELECT 'a' AS k, meta_value AS v FROM ${p}postmeta WHERE meta_key = '_wp_attached_file' AND meta_value = ${hex(rel)} LIMIT 1)`;
	const meta = `(SELECT 'm' AS k, meta_value AS v FROM ${p}postmeta WHERE meta_key = '_wp_attachment_metadata' AND meta_value LIKE CONCAT('%', ${hex('"' + base + '"')}, '%') LIMIT ${META_CAP})`;
	return { rel, base, dir, sql: `${attached} UNION ALL ${meta}` };
}

/** true (an attachment names the key), false (none does), 'other' (not an uploads/ key), or null (could not tell). */
async function referenced(query, prefix, key) {
	const q = referenceQuery(prefix, key);
	if (!q) return 'other';
	const a = await query(q.sql);
	if (!a || !a.ok || !Array.isArray(a.rows)) return null;
	let metaRows = 0;
	let matched = false;
	for (const r of a.rows) {
		const kind = String(r[0]);
		const val = r[1] == null ? '' : String(r[1]);
		if (kind === 'a') return true;
		if (kind !== 'm') continue;
		metaRows++;
		if (!metadataNames(val).includes(q.base)) continue;
		const dir = metadataDir(val);
		if (dir === null || dir === q.dir) matched = true;
	}
	if (matched) return true;
	// A full metadata cap that did not match may have cut off the row that names the file.
	if (metaRows >= META_CAP) return null;
	return false;
}

/**
 * Write `_pf-intent/<key>` before a put, only when the key does not exist yet.
 * Does not throw: a failed head or a failed marker write is could-not-mark, and the caller's put still runs.
 * Returns { marked, reason }.
 */
export async function markNewKey(bucket, key, { reqId = '', now = Date.now(), log = () => {} } = {}) {
	try {
		if (await bucket.head(key)) return { marked: false, reason: 'exists' };
		const body = JSON.stringify({ req: reqId == null ? '' : String(reqId), t: now });
		await bucket.put(markerKey(key), body);
		return { marked: true, reason: 'created' };
	} catch (e) {
		log({ m: 'could-not-mark', key: String(key).slice(0, 200), error: String((e && e.message) || e).slice(0, 160) });
		return { marked: false, reason: 'could-not-mark' };
	}
}

/** Delete the markers of the keys this request created. A delete that fails leaves the marker for the sweep. */
export async function clearMarkers(bucket, keys) {
	for (const k of keys || []) {
		try { await bucket.delete(markerKey(k)); } catch { /* a stale marker is swept by its reference check */ }
	}
}

function sweepLine(out, extra) {
	return {
		m: 'media-sweep',
		seen: out.seen,
		'kept-attached': out.keptAttached,
		deleted: out.deleted,
		'kept-error': out.keptError,
		'skipped-fresh': out.skippedFresh,
		'kept-other': out.keptOther,
		...(extra || {}),
	};
}

/**
 * One sweep. bucket: R2 (list, delete). query(sql): the MySQL read, {ok, rows}. release(key): the name reservation.
 * Logs one media-sweep line. Returns the same counts.
 */
export async function sweepUploadOrphans({ bucket, query, prefix = 'wp_', now = Date.now(), log = () => {}, release = async () => {}, max = SWEEP_MAX } = {}) {
	const cap = Math.max(0, Math.min(Number(max) || 0, SWEEP_MAX));
	const out = { seen: 0, keptAttached: 0, deleted: 0, keptError: 0, skippedFresh: 0, keptOther: 0 };
	let listed;
	try {
		listed = await bucket.list({ prefix: MARKER_PREFIX, limit: cap });
	} catch (e) {
		log(sweepLine(out, { error: String((e && e.message) || e).slice(0, 160) }));
		return out;
	}
	const objects = (listed && listed.objects ? listed.objects : []).slice(0, cap);
	for (const o of objects) {
		out.seen++;
		const t = o.uploaded instanceof Date ? o.uploaded.getTime() : Number(o.uploaded);
		if (!(now - t > STALE_MS)) {
			out.skippedFresh++;
			continue;
		}
		const key = String(o.key || '').startsWith(MARKER_PREFIX) ? String(o.key).slice(MARKER_PREFIX.length) : '';
		if (!key) {
			out.keptError++;
			continue;
		}
		let ref;
		try {
			ref = await referenced(query, prefix, key);
		} catch {
			ref = null;
		}
		if (ref === null) {
			out.keptError++;
			continue;
		}
		if (ref === true || ref === 'other') {
			try {
				await bucket.delete(o.key);
				if (ref === true) out.keptAttached++;
				else out.keptOther++;
			} catch {
				out.keptError++;
			}
			continue;
		}
		try {
			await release(key);
			await bucket.delete(key);
		} catch {
			out.keptError++;
			continue; // the file is still there; the marker stays so the next run tries again
		}
		try { await bucket.delete(o.key); } catch { /* the file is gone; the marker is retried next run */ }
		out.deleted++;
	}
	log(sweepLine(out));
	return out;
}
