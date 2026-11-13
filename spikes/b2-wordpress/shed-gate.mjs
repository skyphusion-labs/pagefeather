// The inbox-wait gate of the PHP object (issue #391).
//
// With the database in the object (DB_IN_DO), a PHP render never yields to the event loop, so
// the object takes no new request while it renders. Requests that arrive meanwhile wait in the
// platform's queue, BEFORE fetch(), where no counter in the object can see them (phpPending reads
// 0). Measured on the throwaway shed1113a (2026-11-13): 80 parallel uncached product GETs all
// answered 503 "overloaded" after about 34 s, and none rendered. A shopper behind such a burst
// waits the whole queue and then fails.
//
// The one signal that sees that queue is the inbox wait: the object's clock at the start of fetch()
// minus the time the Worker sent the request (SENT_HEADER, set by the Worker only). The queue is
// first in, first out, so when the head of the queue has waited longer than a bound, the gate
// answers it at once with a 503 and no PHP. Each shed costs milliseconds, so the queue drains
// in seconds instead of timing out.
//
// Two bounds. A page read (a GET or HEAD that is not cart, checkout, account, admin, login or an
// AJAX or Store API call) is shed past SHED_WAIT_MS. Everything else (a POST, cart, checkout:
// a shopper's write) is shed only past SHED_WAIT_HARD_MS, so it still gets in while page reads are
// shed. A shed request ran no PHP, so a 503 is honest for a write too: nothing was saved.

/** The header the Worker sets to its Date.now() when it sends a request to the object. */
export const SENT_HEADER = 'x-perf-sent';
/** The header the Worker sets to the site's public origin. */
export const ORIGIN_HEADER = 'x-wp-public-origin';

/** Defaults; SHED_WAIT_MS and SHED_WAIT_HARD_MS override them, and "off" turns a bound off. */
export const SHED_WAIT_MS_DEFAULT = 8000;
export const SHED_WAIT_HARD_MS_DEFAULT = 20000;
export const SHED_RETRY_AFTER_S = '5';

// A wait outside this range is clock skew or a bad header, not a queue: it counts as 0 (fail open,
// the request is served). The two clocks are on two machines.
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
	return v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n > 0 ? n : dflt;
}

/** The two bounds from the environment. */
export function shedBounds(env) {
	return {
		softMs: bound(env && env.SHED_WAIT_MS, SHED_WAIT_MS_DEFAULT),
		hardMs: bound(env && env.SHED_WAIT_HARD_MS, SHED_WAIT_HARD_MS_DEFAULT),
	};
}

/** Shed this request? Spike paths (/_...) never are: the deploy tools must reach PHP. */
export function shouldShed(waitMs, cls, url, bounds) {
	if (url.pathname.startsWith('/_')) return false;
	return waitMs > (cls === 'hard' ? bounds.hardMs : bounds.softMs);
}

/** The shed answer: a 503 no cache keeps, with a retry hint. */
export function shedResponse(waitMs, cls, objectName) {
	return new Response('The site is busy. Please try again in a few seconds.\n', {
		status: 503,
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			'cloudflare-cdn-cache-control': 'no-store',
			'retry-after': SHED_RETRY_AFTER_S,
			'x-shed': cls,
			'x-shed-wait-ms': String(Math.round(waitMs)),
			'x-php-object': objectName,
		},
	});
}
