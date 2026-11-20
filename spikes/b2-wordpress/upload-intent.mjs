// #1039, approach A (Hyperdrive): a media upload whose request dies must not leave its R2 files without an attachment.
// Approach A has no request frame (MySQL autocommits, and a 1102 kill runs no Worker code after it), so nothing can be
// undone at the failure. Instead (the lead's ruling, 2026-11-20):
//   - on a MEDIA UPLOAD request only (isMediaUploadRequest: the paths that create an attachment), every R2 key the
//     request CREATES gets a marker object first (MARKER_PREFIX + key, customMetadata kind=upload);
//   - when PHP answers 2xx, the request drops its own markers (dropMarkersOn); any other answer leaves them for the sweep;
//   - the sweep (the throttled start of a media upload) looks only at UPLOAD markers older than STALE_MS: a file whose
//     attachment exists (_wp_attached_file, every metadata size, original_image) keeps its file and loses the marker;
//     one that no attachment names is deleted with its marker and its name reservation (an upload-orphan-swept event).
// A file with no marker is never touched: fonts, invoices, exports, logs and form uploads are never candidates.
export const MARKER_PREFIX = '_pf-intent/';
export const STALE_MS = 15 * 60 * 1000;
export const SWEEP_MAX = 25; // markers per sweep (the next sweep takes the rest)

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

/** A request on a path that creates an attachment: async-upload.php, media-new.php, media-upload.php, REST POST /wp/v2/media. */
export function isMediaUploadRequest(method, pathname, search) {
	if (String(method || '').toUpperCase() !== 'POST') return false;
	if (/\/wp-admin\/(?:async-upload|media-new|media-upload)\.php$/.test(String(pathname || ''))) return true;
	const r = restRoute(pathname, search);
	return r !== null && /^\/wp\/v2\/media\/?$/.test(r);
}

/**
 * Whether a request's markers drop when PHP answers: only a 2xx (the lead's review on #1051). A 500 after the files
 * were stored is the same orphan as a kill, so its markers stay and the sweep decides by the attachment rows. A 3xx
 * (media-new.php redirects after a save) keeps them too; the sweep then finds the attachment and drops only the marker.
 */
export function dropMarkersOn(status) {
	return Number.isInteger(status) && status >= 200 && status <= 299;
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

const hex = (s) => "CONVERT(X'" + [...new TextEncoder().encode(String(s))].map((b) => b.toString(16).padStart(2, '0')).join('') + "' USING utf8mb4)";

/**
 * The two reads that say whether an attachment names an R2 key under uploads/, or null for any other key. Only hex
 * literals carry the name, so no file name is ever SQL text. attached: a row whose _wp_attached_file is the file.
 * meta: the metadata of the attachments in the same directory whose metadata mentions the name (checked exactly by
 * metadataNames after the read; a LIKE wildcard in the name only widens the read, never the decision).
 */
export function referenceQueries(prefix, key) {
	const k = String(key);
	if (!k.startsWith('uploads/')) return null;
	const rel = k.slice('uploads/'.length);
	const slash = rel.lastIndexOf('/');
	const dir = slash < 0 ? '' : rel.slice(0, slash);
	const base = slash < 0 ? rel : rel.slice(slash + 1);
	const p = String(prefix || 'wp_').replace(/[^A-Za-z0-9_]/g, '');
	const attached = `SELECT COUNT(*) AS n FROM ${p}postmeta WHERE meta_key = '_wp_attached_file' AND meta_value = ${hex(rel)}`;
	const inDir = dir ? `af.meta_value LIKE CONCAT(${hex(dir)}, '/%')` : `af.meta_value NOT LIKE '%/%'`;
	const meta = `SELECT pm.meta_value AS v FROM ${p}postmeta pm JOIN ${p}postmeta af ON af.post_id = pm.post_id AND af.meta_key = '_wp_attached_file' WHERE pm.meta_key = '_wp_attachment_metadata' AND ${inDir} AND pm.meta_value LIKE CONCAT('%', ${hex('"' + base + '"')}, '%')`;
	return { rel, base, attached, meta };
}

/** true (an attachment names the key), false (none does), or null (could not tell: the caller keeps the file). */
async function referenced(query, prefix, key) {
	const q = referenceQueries(prefix, key);
	if (!q) return true; // not an upload file: never a candidate
	const a = await query(q.attached);
	if (!a || !a.ok || !a.rows) return null;
	if (Number(a.rows[0] && a.rows[0][0]) > 0) return true;
	const m = await query(q.meta);
	if (!m || !m.ok || !m.rows) return null;
	return m.rows.some((r) => metadataNames(r[0]).includes(q.base));
}

/**
 * One sweep. bucket: R2 (list, delete). query(sql): the MySQL read, {ok, rows}. release(key): the name reservation.
 * Returns { markers, swept, kept, fresh, errors }.
 */
export async function sweepUploadOrphans({ bucket, query, prefix = 'wp_', now = Date.now(), log = () => {}, release = async () => {}, max = SWEEP_MAX }) {
	const out = { markers: 0, swept: 0, kept: 0, fresh: 0, errors: 0 };
	const l = await bucket.list({ prefix: MARKER_PREFIX, include: ['customMetadata'], limit: max });
	for (const o of l.objects || []) {
		out.markers++;
		if (!o.customMetadata || o.customMetadata.kind !== 'upload') continue; // not ours to act on
		const t = o.uploaded instanceof Date ? o.uploaded.getTime() : Number(o.uploaded);
		if (!(now - t > STALE_MS)) {
			out.fresh++;
			continue;
		}
		const key = o.key.slice(MARKER_PREFIX.length);
		let ref;
		try {
			ref = await referenced(query, prefix, key);
		} catch {
			ref = null;
		}
		if (ref === null) {
			out.errors++;
			continue; // keep both; the next sweep asks again
		}
		if (ref) {
			await bucket.delete(o.key);
			out.kept++;
			continue;
		}
		await release(key);
		await bucket.delete(key);
		await bucket.delete(o.key);
		out.swept++;
		log({ '@event': 'upload-orphan-swept', m: 'upload-orphan-swept', key: key.slice(0, 200), markerAgeS: Math.round((now - t) / 1000) });
	}
	return out;
}
