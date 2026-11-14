// The scheduled snapshot of a site's database into its OWN bucket (#533, design A').
//
// The site's dispatcher copy (wp-<site>, phase A) has a daily cron. Its scheduled() handler calls
// POST /_dbsnapshot on this site's user Worker through the dispatch namespace binding, with the
// site's own SNAPSHOT_TOKEN (a secret on both scripts, minted per site, not SPIKE_TOKEN). Here the
// object dumps its SQLite (the same dumpTo as /_dbexport), gzips it, and writes it to MEDIA under
// _snapshots/auto/. The dump never leaves this site's isolate and bucket. Measured on the live
// path 2026-11-14: a cron on an ordinary Worker reaches a user Worker through its
// dispatch_namespace binding (#533, the v2 probe).
//
// The answer is JSON: {ok, key, bytes, rawBytes, rows, build, ms} on 200, {ok: false, error} else:
//   403 forbidden    no SNAPSHOT_TOKEN on this site, or a wrong or missing token (one answer for
//                    both, so a caller learns nothing about which)
//   405 method       the token is right, the method is not POST
//   409 import-held  a /_dbimport is in progress (import-hold.mjs): skipped, not stored
//   413 too-big      the raw dump passed maxRawBytes: nothing is stored
//   500 dump-error / dump-empty / readback   nothing usable is stored (a readback failure names it)

export const SNAPSHOT_PATH = '/_dbsnapshot';
export const SNAPSHOT_HEADER = 'x-snapshot-token';
export const SNAPSHOT_PREFIX = '_snapshots/auto/';
// The raw NDJSON cap. Only the gzipped bytes are held in memory (about a quarter of the raw size,
// and the ggc store measured 3.7 MB raw, #533), next to the PHP runtime in the same isolate.
export const SNAPSHOT_MAX_RAW_BYTES = 128 * 1024 * 1024;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Compare two strings in time that depends on their length only. */
export function sameToken(given, want) {
	const a = enc.encode(String(given));
	const b = enc.encode(String(want));
	let diff = a.length ^ b.length;
	for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
	return b.length > 0 && diff === 0;
}

/** 'ok', 'forbidden' or 'method'. The token is checked before the method, so a request without the
 * token learns nothing (every such request is 403). */
export function snapshotGate(req, env) {
	const want = env && env.SNAPSHOT_TOKEN;
	if (!want || !sameToken(req.headers.get(SNAPSHOT_HEADER) || '', want)) return 'forbidden';
	if (req.method !== 'POST') return 'method';
	return 'ok';
}

export function gateResponse(gate) {
	const status = gate === 'method' ? 405 : 403;
	return Response.json({ ok: false, error: gate }, { status, headers: { 'cache-control': 'private, no-store' } });
}

/** _snapshots/auto/<UTC yyyymmddThhmmssZ>.ndjson.gz: keys sort in time order. */
export function snapshotKey(now) {
	const t = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
	return SNAPSHOT_PREFIX + t + '.ndjson.gz';
}

const ERROR_LINE = enc.encode('{"error"');
const startsWith = (chunk, pre) => chunk.byteLength >= pre.length && pre.every((x, i) => chunk[i] === x);

/**
 * Take one snapshot. `dump(writer)` writes NDJSON, ONE line per write, and closes the writer
 * (index.js dumpTo): a {"error"} line on failure, else {"end": true, "rows": n} last.
 * `media` is the site's R2 binding (put, head).
 * Returns {status, body}.
 */
export async function takeSnapshot({ dump, media, now = Date.now(), build = '', held = false, maxRawBytes = SNAPSHOT_MAX_RAW_BYTES, clock = Date.now }) {
	const t0 = clock();
	if (held) return { status: 409, body: { ok: false, error: 'import-held' } };
	const { readable, writable } = new TransformStream();
	let raw = 0;
	let last = null;
	let errorLine = null;
	let tooBig = false;
	const tap = new TransformStream({
		transform(chunk, c) {
			raw += chunk.byteLength;
			if (raw > maxRawBytes) {
				tooBig = true;
				c.error(new Error('too-big'));
				return;
			}
			if (startsWith(chunk, ERROR_LINE)) errorLine = chunk;
			last = chunk;
			c.enqueue(chunk);
		},
	});
	// A dump that throws, or returns without closing, must still end the read below: the writer is
	// aborted on a throw and closed on a return (a second close of a closed writer is ignored).
	const writer = writable.getWriter();
	const dumping = Promise.resolve()
		.then(() => dump(writer))
		.then(
			() => writer.close().catch(() => {}),
			(e) => {
				errorLine = errorLine || enc.encode(JSON.stringify({ error: String((e && e.message) || e) }));
				return writer.abort(e).catch(() => {});
			},
		);
	const parts = [];
	let size = 0;
	try {
		for await (const c of readable.pipeThrough(tap).pipeThrough(new CompressionStream('gzip'))) {
			parts.push(c);
			size += c.byteLength;
		}
	} catch (e) {
		if (!tooBig) errorLine = errorLine || enc.encode(JSON.stringify({ error: String((e && e.message) || e) }));
	}
	await dumping;
	const ms = () => clock() - t0;
	if (tooBig) return { status: 413, body: { ok: false, error: 'too-big', rawBytes: raw, maxRawBytes, ms: ms() } };
	if (errorLine) return { status: 500, body: { ok: false, error: 'dump-error', detail: dec.decode(errorLine).slice(0, 300), ms: ms() } };
	let end = null;
	try {
		end = last ? JSON.parse(dec.decode(last)) : null;
	} catch {
		end = null;
	}
	if (!end || end.end !== true || !Number.isInteger(end.rows)) return { status: 500, body: { ok: false, error: 'dump-empty', rawBytes: raw, ms: ms() } };
	const bytes = new Uint8Array(size);
	let off = 0;
	for (const p of parts) {
		bytes.set(p, off);
		off += p.byteLength;
	}
	const key = snapshotKey(now);
	await media.put(key, bytes, {
		httpMetadata: { contentType: 'application/gzip' },
		customMetadata: { rows: String(end.rows), rawBytes: String(raw), build: String(build || '') },
	});
	const h = await media.head(key);
	if (!h || h.size !== bytes.byteLength) return { status: 500, body: { ok: false, error: 'readback', key, bytes: bytes.byteLength, stored: h ? h.size : null, ms: ms() } };
	return { status: 200, body: { ok: true, key, bytes: bytes.byteLength, rawBytes: raw, rows: end.rows, build: String(build || ''), ms: ms() } };
}
