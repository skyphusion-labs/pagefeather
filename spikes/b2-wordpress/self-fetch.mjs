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

export function selfFetchRoute({ sameHost, inObject, overflowed, poolAvailable, capped }) {
	if (!sameHost) return { route: 'out' };
	if (overflowed) return { route: 'refuse', why: SELF_REFUSAL_GUARD };
	if (inObject) return { route: 'refuse', why: SELF_REFUSAL_OBJECT };
	if (!poolAvailable) return { route: 'refuse', why: SELF_REFUSAL_NO_POOL };
	if (capped) return { route: 'refuse', why: SELF_REFUSAL_CAPPED };
	return { route: 'pool' };
}

// poolAvailable: the same condition as the Worker's overflow dispatch (approach A, a PhpRuntime binding, the pool on,
// and neither PHP nor the database in an object).
export function selfFetchPoolAvailable(env, ovs) {
	return Boolean(env && env.PHP_RUNTIME && ovs && ovs.on && env.PHP_IN_DO !== 'on' && env.DB_IN_DO !== 'on');
}
