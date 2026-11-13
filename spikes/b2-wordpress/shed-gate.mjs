// The in-object gate of the PHP object (issue #391).
//
// Measured on the throwaway shed1113a (2026-11-13, main 8b69800, the sample store):
// - With the database in the object (DB_IN_DO), a PHP render never yields, and the PHP lock was a
//   promise chain, so the next render started in the same microtask flush as the last one ended.
//   The event loop never had a turn to send a finished answer: in a burst every answer left at the
//   end (N=16: all within 0.3 s at about 17 s), and from N=48 the isolate reset or the platform
//   refused at about 33 s. withPhp() now yields one turn before each render, so answers leave one by
//   one (about 0.7 s apart).
// - With the yield, the waiting requests sit INSIDE the 128 MiB isolate, and a shopper's cart add
//   behind 16 GETs died in a memory reset (3 of 3 runs). So the object admits a bounded number of
//   requests and answers the rest at once with a 503 and no PHP. The count of requests in the
//   object (inObject) is exact: the object is single threaded and this module counts every fetch().
//
// Two bounds. A page read (a GET or HEAD that is not cart, checkout, account, admin, login or an
// AJAX or Store API call) is shed when SHED_SOFT requests are already in the object. Everything
// else (a POST, cart, checkout: a shopper's write) waits OUTSIDE: it is shed while SHED_HARD (1)
// or more requests are in the object, with Retry-After: 1. Probe on shed1113a (2026-11-13): a
// write that entered while renders were in flight died in a memory reset before its own render
// began (9 of 10 runs), with no runtime recycle; a write into an empty object never did. A shed
// request ran no PHP, so a 503 is honest for a write too: nothing was saved.

/** The header the Worker sets to its Date.now() when it sends a request to the object. */
export const SENT_HEADER = 'x-perf-sent';
/** The header the Worker sets to the site's public origin. */
export const ORIGIN_HEADER = 'x-wp-public-origin';

/** Defaults (set from the shed1113a sweep, see the PR); SHED_SOFT and SHED_HARD override them, "off" turns one off. */
export const SHED_SOFT_DEFAULT = 8;
export const SHED_HARD_DEFAULT = 1;
export const SHED_RETRY_AFTER_S = '5';
export const SHED_RETRY_AFTER_HARD_S = '1';

// The inbox wait is reported on a shed answer (x-shed-wait-ms, operator only). A wait outside this
// range is clock skew or a bad header: it counts as 0 (fail open). The two clocks are on two machines.
export const WAIT_MAX_PLAUSIBLE_MS = 120000;
export const WAIT_MIN_PLAUSIBLE_MS = -5000;

/**
 * Copy a request for the object, with the two Worker-only headers set by the Worker. A copy a
 * client sent is replaced, never kept: the gate trusts SENT_HEADER only because of this.
 */
export function stampForObject(req, origin, now) {
	const fwd = new Request(req);
	fwd.headers.set(ORIGIN_HEADER, origin);
	fwd.headers.set(SENT_HEADER, String(now));
	return fwd;
}

/** Milliseconds the request waited before fetch(). 0 when the header is missing or implausible. */
export function inboxWaitMs(sent, now) {
	if (sent === null || sent === undefined || sent === '') return 0;
	const t = Number(sent);
	if (!Number.isFinite(t)) return 0;
	const w = now - t;
	if (w > WAIT_MAX_PLAUSIBLE_MS || w < WAIT_MIN_PLAUSIBLE_MS) return 0;
	return w > 0 ? w : 0;
}

const HARD_PATH = /^\/(cart|checkout|my-account|wp-admin|wp-login\.php|wc-api|wp-json\/wc\/store)(\/|$|\?)/;
const HARD_PARAM = ['wc-ajax', 'add-to-cart', 'rest_route', 'wc-api'];

/** "soft" for a page read the gate may shed early, "hard" for a write or a shopper's own page. */
export function shedClass(method, url) {
	const m = String(method || '').toUpperCase();
	if (m !== 'GET' && m !== 'HEAD') return 'hard';
	if (HARD_PATH.test(url.pathname)) return 'hard';
	if (HARD_PARAM.some((k) => url.searchParams.has(k))) return 'hard';
	return 'soft';
}

function bound(v, dflt) {
	if (v === 'off') return Infinity;
	const n = Number(v);
	return v !== undefined && v !== null && v !== '' && Number.isInteger(n) && n > 0 ? n : dflt;
}

/** The two bounds from the environment: how many requests may be in the object already. */
export function shedBounds(env) {
	return {
		soft: bound(env && env.SHED_SOFT, SHED_SOFT_DEFAULT),
		hard: bound(env && env.SHED_HARD, SHED_HARD_DEFAULT),
	};
}

/** Shed this request, with `inObject` requests already in the object? Spike paths (/_...) never are. */
export function shouldShed(inObject, cls, url, bounds) {
	if (url.pathname.startsWith('/_')) return false;
	return inObject >= (cls === 'hard' ? bounds.hard : bounds.soft);
}

// The requests in the object now (passed the gate, fetch() not yet ended).
let inObject = 0;
/** For the object: run serve() for an admitted request, counted, or answer a shed. */
export async function gated(raw, env, objectUrl, objectName, serve, now = Date.now()) {
	const cls = shedClass(raw.method, objectUrl);
	if (shouldShed(inObject, cls, objectUrl, shedBounds(env))) return shedResponse(inboxWaitMs(raw.headers.get(SENT_HEADER), now), cls, objectName, inObject);
	inObject++;
	try {
		return await serve();
	} finally {
		inObject--;
	}
}
/** For tests. */
export function inObjectCount() {
	return inObject;
}

/** The shed answer: a 503 no cache keeps, with a retry hint. */
export function shedResponse(waitMs, cls, objectName, inObjectNow = null) {
	return new Response('The site is busy. Please try again in a few seconds.\n', {
		status: 503,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			'cloudflare-cdn-cache-control': 'no-store',
			'retry-after': cls === 'hard' ? SHED_RETRY_AFTER_HARD_S : SHED_RETRY_AFTER_S,
			'x-shed': cls,
			'x-shed-wait-ms': String(Math.round(waitMs)),
			'x-php-object': objectName,
			...(inObjectNow === null ? {} : { 'x-shed-in-object': String(inObjectNow) }),
		},
	});
}

