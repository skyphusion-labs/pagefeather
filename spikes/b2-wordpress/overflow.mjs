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
//   PHP_OVERFLOW_POOL     pool size, 1 to 128 (default 32, the measured best: pools 8 and 16 were WORSE than no
//                         overflow at 250 concurrent checkouts, 32 the only setting with 0 exceededMemory; #296,
//                         2026-11-15); a bad value falls back to 32. Objects are named ovf-<i>
//   PHP_OVERFLOW_HINT     the location hint for the objects (default wnam, measured best)
//   PHP_OVERFLOW_BUSY     on: an object already running PHP answers busy and the Worker tries elsewhere (default
//                         OFF: at pool 32, busy moved the queue back into the Worker and brought 5 exceededMemory
//                         back at 250 concurrent; without it, 0. #296, 2026-11-15)
// Never moved: spike and operator paths (/_*) and media uploads (their body is staged in R2 here).
// Routing: power of two choices over the in-flight count this isolate holds per object.
// BUSY (#296 (3)(c), ruled 2026-11-15): (c) measured the queue moving INTO the pool (pool 32: 507 of 699 granted
// waits in objects, object queues up to 8 deep). So an object that already runs or holds PHP answers busy BEFORE it
// runs anything, and the Worker tries its second choice, then runs the request locally. The object's own lock is
// the real queue state; no shared estimate is needed. Only a retry-safe request may be answered busy (index.js:
// a Turnstile-gated one is verified once, so it is never retried).
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
		pool: int(env && env.PHP_OVERFLOW_POOL, 1, 128, 32),
		hint: HINTS.has(hint) ? hint : 'wnam',
		busy: env ? String(env.PHP_OVERFLOW_BUSY || '').trim() === 'on' : false,
		// #714: the most overflowed requests one Worker isolate holds in flight (default 16; "off": no cap). An isolate
		// that died holding them took every one with it (3 to 5 shoppers, a 503 after about 40 s, in both #296 arms).
		maxHeld: env && String(env.PHP_OVERFLOW_MAX_HELD || '').trim() === 'off' ? 0 : int(env && env.PHP_OVERFLOW_MAX_HELD, 1, 1000, 16),
	};
}

// #714: true when this isolate already holds maxHeld overflowed requests (the next one is refused, never forwarded).
export function overHeld(s, held) {
	return !!s && s.maxHeld > 0 && held >= s.maxHeld;
}

// #714: the at-cap answer. Nothing ran and nothing was forwarded, so the client may simply try again.
export function overflowCapResponse() {
	const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'retry-after': '5', 'x-php-overflow': 'capped', 'x-write-loss': 'none', 'x-overloaded': '1', 'cache-control': 'no-store, private' });
	return new Response('The site is busy and did not start your request. Please try again in a few seconds.\n', { status: 503, headers });
}

// lock: { running, waiting } of this isolate's PHP lock, read just before the request would queue.
export function shouldOverflow(s, lock, url, isUpload) {
	if (!s || !s.on) return false;
	if (url.pathname.startsWith('/_') || isUpload) return false;
	if (s.always) return true;
	return lock.running > 0 && lock.waiting >= s.depth;
}

// An object with a run in flight or a waiter is busy (lock: its php-lock.mjs { running, waiting }).
export function objectBusy(lock) {
	return lock.running > 0 || lock.waiting > 0;
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
		// The two choices, the less loaded first (the Worker tries the second when the first answers busy).
		pickTwo() {
			if (pool === 1) return [0];
			const i = Math.min(pool - 1, Math.floor(rand() * pool));
			let j = Math.min(pool - 2, Math.floor(rand() * (pool - 1)));
			if (j >= i) j++;
			return inflight[j] < inflight[i] ? [j, i] : [i, j];
		},
		start(i) { inflight[i]++; },
		end(i) { inflight[i] = Math.max(0, inflight[i] - 1); },
		inflight(i) { return inflight[i]; },
	};
}
