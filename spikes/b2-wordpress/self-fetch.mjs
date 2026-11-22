// #1157: a server-side request to the site's OWN host (url-details, Site Health's loopback check, a plugin that calls
// its own REST route) cannot go out through global fetch(). Cloudflare: "Routes cannot be the target of a same-zone
// fetch() call", and a same-zone fetch() without a service binding fails (error 1042, also for workers.dev). It
// cannot run in this isolate either: the request that asks holds the isolate's one PHP runtime, so it would wait on
// itself. On approach A the overflow pool (on by default since #1140) has OTHER runtimes: a PhpRuntime object is
// called through its binding (stub.fetch, never a public URL) and runs the request on its own PHP.
//
// selfFetchRoute decides, for one hop of the HTTP bridge:
// - 'out': not the site's own host; the normal path (HTTP_ALLOW_HOSTS, fetch()).
// - 'pool': the site's own host, on the approach A Worker with the pool available: send it to a pool object.
// - 'refuse': the site's own host, and no other runtime to run it on. The reason names why:
//   - in an object (a pool object, the cron object, or a DO tier's site object): the RECURSION GUARD. A request a
//     pool object runs never asks for another pool object, so a self-request is one hop deep at most and cannot
//     loop or hold the pool on itself;
//   - no pool (the overflow opt-out, PHP_IN_DO or DB_IN_DO, or b-dosql: a Cloudflare platform limit there);
//   - the pool's held cap (PHP_OVERFLOW_MAX_HELD) is reached.
export const SELF_REFUSAL_OBJECT = 'a request to this site itself is refused: the PHP object runs one request at a time, so it would wait on itself';
export const SELF_REFUSAL_GUARD = 'a request to this site itself is refused here: it is already running on a pool object, and a pool request never calls the pool again';
export const SELF_REFUSAL_NO_POOL = 'a request to this site itself is refused: no other PHP runtime to run it on (the overflow pool is off), and Cloudflare does not route a fetch() to its own zone';
// Same-isolate guard: the hop is safe only because the pool object runs its OWN PHP. If the object runs in THIS isolate
// (local workerd does: the Worker and every object share one isolate and one PHP lock), the request would queue behind
// the request that asked for it until the asker times out. The Worker records each in-flight hop's call id here; an
// object that finds the id in its own isolate answers at once (503 and SELF_SAME_ISOLATE_HEADER) instead of queueing,
// and the hop is refused.
export const selfFetchCalls = new Set();
export const SELF_SAME_ISOLATE_HEADER = 'x-pf-self-same-isolate';
export const SELF_REFUSAL_SAME_ISOLATE = 'a request to this site itself is refused: the pool object runs in this isolate, so it would wait on this request';
export function selfFetchSameIsolate(overflowed, callId) {
	return Boolean(overflowed && callId && selfFetchCalls.has(callId));
}
export const SELF_REFUSAL_CAPPED = 'a request to this site itself is refused: this isolate holds its most overflowed requests (PHP_OVERFLOW_MAX_HELD)';

// - 'cache' (#1157 after #1298): the site's own host on the approach A Worker with NO pool but the Pages export: a
//   guest GET can still be answered from the front page cache, which needs no other runtime (#1170 measured it); only
//   a miss is refused, with missWhy.
export function selfFetchRoute({ sameHost, inObject, overflowed, poolAvailable, capped, cacheAvailable = false }) {
	if (!sameHost) return { route: 'out' };
	if (overflowed) return { route: 'refuse', why: SELF_REFUSAL_GUARD };
	if (inObject) return { route: 'refuse', why: SELF_REFUSAL_OBJECT };
	if (!poolAvailable) return cacheAvailable ? { route: 'cache', missWhy: SELF_REFUSAL_NO_POOL } : { route: 'refuse', why: SELF_REFUSAL_NO_POOL };
	if (capped) return { route: 'refuse', why: SELF_REFUSAL_CAPPED };
	return { route: 'pool' };
}

// poolAvailable: the same condition as the Worker's overflow dispatch (approach A, a PhpRuntime binding, the pool on,
// and neither PHP nor the database in an object).
export function selfFetchPoolAvailable(env, ovs) {
	return Boolean(env && env.PHP_RUNTIME && ovs && ovs.on && env.PHP_IN_DO !== 'on' && env.DB_IN_DO !== 'on');
}

// #1170 live (strummer, cf759hx): each try picked a different COLD pool object, a boot plus two PHP runs (the 301), 5.8
// to 8.6 s, past WordPress's 5 s timeout. Self-fetches now go to ONE named object, outside the client picker's names,
// kept warm by its own use. Each hop is sent with redirect: 'manual', so a redirect comes back to the bridge loop, which
// checks the next hop like the first and sends a same-host one to the same warm object.
export const SELF_FETCH_OBJECT = 'ovf-self';

// The outcome named on the self-fetch line, which is logged on every path (a timeout left no line before).
export function selfFetchOutcome({ status, aborted, error, sameIsolate }) {
	if (aborted) return 'timeout';
	if (error) return 'error';
	if (sameIsolate) return 'same-isolate';
	return status === null || status === undefined ? 'error' : 'ok';
}

// #1170 lever: a guest self-GET is answered from the front page cache when cached. The hop carries this header; the
// Pages entrypoint, which a cache hit never reaches, answers a marked request at once with this miss (never stored),
// so a miss never renders through Pages in the asking isolate. The gateway strips a client copy.
export const SELF_CACHE_ONLY_HEADER = 'x-pf-self-cache-only';
export const SELF_CACHE_MISS_HEADER = 'x-pf-self-cache-miss';
export function selfCacheMissResponse() {
	return new Response(null, { status: 504, headers: { [SELF_CACHE_MISS_HEADER]: '1', 'cache-control': 'no-store, private' } });
}

// #1157 (d), Conrad's choice 2026-11-22: the reply PHP gets for a refused request. A refusal of a request to the site's
// own host is marked self: true, so the bridge (php/http-bridge.php, skyphusion_http_self_refused) can answer the one
// narrow case php/url-details-self.php covers, a url-details GET, in-process with no HTTP hop. Only these reasons are
// marked; an outbound host refusal, a timeout or a fetch error stays a plain error.
const SELF_REFUSALS = new Set([SELF_REFUSAL_OBJECT, SELF_REFUSAL_GUARD, SELF_REFUSAL_NO_POOL, SELF_REFUSAL_CAPPED, SELF_REFUSAL_SAME_ISOLATE]);
export function httpErrorReply(why) {
	return SELF_REFUSALS.has(why) ? { error: why, self: true } : { error: why };
}
