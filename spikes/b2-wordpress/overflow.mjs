// PHP overflow to a Durable Object pool on approach A (#296 step (3); ruled 2026-11-15).
//
// Approach A runs PHP in the Worker isolate, one request at a time (php-lock.mjs). Cloudflare keeps
// routing new requests to an isolate whose run is waiting on MySQL, so queues build: run 2 measured a
// granted wait of 15 s p50 at 250 concurrent, behind runs of 0.6 s. A plain DO pool loses (probe 3):
// from a pool object a query costs 26 ms p50 (SJC, locationHint wnam) against 8 ms from the placed
// Worker (SEA). So the Worker keeps running PHP when it can, and only a request that would WAIT goes to a
// pool object, BEFORE it has run (so a write can never run twice). Each object has its own isolate
// (probe 3: 8 of 8 and 32 of 32), so one PHP runtime per object and no stacking.
//
//   PHP_OVERFLOW          off (default) | on | always (every eligible request: the functional proof only)
//   PHP_OVERFLOW_DEPTH    overflow when this isolate has a run in flight AND at least this many waiting
//                         (default 1; 0 means any run in flight), 0 to 50
//   PHP_OVERFLOW_POOL     pool size, 1 to 128 (default 8); objects are named ovf-<i>
//   PHP_OVERFLOW_HINT     the location hint for the objects (default wnam, measured best)
// Never moved: spike and operator paths (/_*) and media uploads (their body is staged in R2 here).
// Routing: power of two choices over the in-flight count this isolate holds per object.
// Pure, so tests/overflow.test.mjs drives it.

const HINTS = new Set(['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me']);
const int = (v, lo, hi, def) => {
	const s = String(v === undefined || v === null ? '' : v).trim();
	if (!/^[0-9]+$/.test(s)) return def;
	const n = Number(s);
	return n >= lo && n <= hi ? n : def;
};

export function overflowSettings(env) {
	const mode = env ? String(env.PHP_OVERFLOW || '').trim() : '';
	const hint = env ? String(env.PHP_OVERFLOW_HINT || '').trim() : '';
	return {
		on: mode === 'on' || mode === 'always',
		always: mode === 'always',
		depth: int(env && env.PHP_OVERFLOW_DEPTH, 0, 50, 1),
		pool: int(env && env.PHP_OVERFLOW_POOL, 1, 128, 8),
		hint: HINTS.has(hint) ? hint : 'wnam',
	};
}

// lock: { running, waiting } of this isolate's PHP lock, read just before the request would queue.
export function shouldOverflow(s, lock, url, isUpload) {
	if (!s || !s.on) return false;
	if (url.pathname.startsWith('/_') || isUpload) return false;
	if (s.always) return true;
	return lock.running > 0 && lock.waiting >= s.depth;
}

export function overflowName(i) {
	return 'ovf-' + i;
}

export function createPicker(pool, rand = Math.random) {
	const inflight = new Array(pool).fill(0);
	return {
		pick() {
			if (pool === 1) return 0;
			const i = Math.min(pool - 1, Math.floor(rand() * pool));
			let j = Math.min(pool - 2, Math.floor(rand() * (pool - 1)));
			if (j >= i) j++;
			return inflight[j] < inflight[i] ? j : i;
		},
		start(i) { inflight[i]++; },
		end(i) { inflight[i] = Math.max(0, inflight[i] - 1); },
		inflight(i) { return inflight[i]; },
	};
}
