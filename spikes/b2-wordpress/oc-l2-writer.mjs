// The object-cache L2 (KV) write path on approach A (#500). Every persistent set wrote through to
// KV, and WordPress re-sets hot keys on most requests, often to the same value. KV takes about one
// write per second per key, so under load many isolates writing one key got 429s: 1512 "KV PUT
// failed: 429 Too Many Requests" in the 5/25/50-user run on wp-a-lean (2026-11-14, #394), each a
// wasted subrequest, and the KV copy of that key stale. Per isolate, this writer:
//   - skips a PUT when the value equals what this isolate last wrote or read for the key, unless the
//     KV copy is near its expiry (refreshAfterMs);
//   - coalesces: at most one PUT per key per minGapMs; a newer value inside the gap is written once
//     when the gap ends (the LATEST value, never dropped, so KV does not keep an old one);
//   - caps the PUTs one request may start (capPerRequest); past the cap the value is left to the
//     isolate's Map (KV just misses later) and counted;
//   - counts every outcome (put, skipped, coalesced, capped, throttled for a 429, failed) instead of
//     logging each one. A delete always goes through (it removes a value; a stale one would serve).

export function createL2Writer({ put, del, now = () => Date.now(), minGapMs = 1000, refreshAfterMs = 45000, capPerRequest = 32, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)) }) {
	const last = new Map(); // key -> { v, t } what this isolate last wrote or read, and when it was written
	const lastPut = new Map(); // key -> the time of the last PUT started
	const pending = new Map(); // key -> { v, ttl } the latest value waiting for the gap to end
	const counts = { put: 0, skipped: 0, coalesced: 0, capped: 0, throttled: 0, failed: 0 };
	let thisRequest = 0;
	const fail = (e) => {
		if (/\b429\b|Too Many Requests/i.test(String((e && e.message) || e))) counts.throttled++;
		else counts.failed++;
	};
	const start = (k, v, ttl) => {
		counts.put++;
		thisRequest++;
		lastPut.set(k, now());
		last.set(k, { v, t: now() });
		let p;
		try {
			p = Promise.resolve(put(k, v, ttl));
		} catch (e) {
			p = Promise.reject(e);
		}
		return p.catch(fail); // a 429 is counted, never an unhandled rejection
	};
	return {
		counts,
		/** A new request: its PUT cap starts again. */
		beginRequest() { thisRequest = 0; },
		/** A KV read returned v for k: a later set of the same v needs no PUT. */
		noteRead(k, v) { if (!last.has(k)) last.set(k, { v, t: now() }); },
		/** A persistent set of k to v (KV ttl seconds). Returns the promise to waitUntil, or null. */
		set(k, v, ttl) {
			const seen = last.get(k);
			if (seen && seen.v === v && now() - seen.t < refreshAfterMs && !pending.has(k)) { counts.skipped++; return null; }
			if (thisRequest >= capPerRequest) { counts.capped++; return null; }
			const since = now() - (lastPut.get(k) || -Infinity);
			if (since >= minGapMs && !pending.has(k)) return start(k, v, ttl);
			// Inside the gap: keep the newest value, and write it once when the gap ends.
			counts.coalesced++;
			const had = pending.has(k);
			pending.set(k, { v, ttl });
			if (had) return null; // a write of this key is already scheduled; it takes the newest value
			return sleep(Math.max(0, minGapMs - since)).then(() => {
				const w = pending.get(k);
				pending.delete(k);
				return w ? start(k, w.v, w.ttl) : undefined;
			});
		},
		/** A delete of k always goes through; it also forgets what this isolate knew of k. */
		del(k) {
			last.delete(k);
			pending.delete(k);
			let p;
			try {
				p = Promise.resolve(del(k));
			} catch (e) {
				p = Promise.reject(e);
			}
			return p.catch(fail);
		},
	};
}
