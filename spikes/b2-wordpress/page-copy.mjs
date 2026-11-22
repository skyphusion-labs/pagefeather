// The page cache's request conditions (Workers Cache, issue #63), in one place: what can have a stored copy, what goes
// to the cached Pages entrypoint, and what the store decision requires of the request. index.js uses these and keeps
// no copy of them, so the routing, the store and the #1328 busy answer cannot drift apart.
//
// Only the Pages entrypoint is cached. The default entrypoint (the gateway, not cached) sends it a GET or HEAD that
// has no WordPress cookie (WP_COOKIE, by name) and is not an admin, login, cron or spike path, WITHOUT the Cookie
// header. So the cache key is the path and the query alone, and a cookie that is not WordPress's (analytics _ga,
// WooCommerce order attribution sbjs_*) does not split it. Before #63 the default entrypoint was cached with Vary:
// Cookie, keyed on the whole Cookie header: every visitor with any such cookie was a separate variant (measured on
// wp-perf-dosql, docs/approach-b.md 8c).
import { isOperatorRequest } from './perf-headers.mjs';
import { probeArm } from './placement-probe.mjs';

export const WP_COOKIE = /(^|;\s*)(wordpress_logged_in_|wordpress_sec_|wp-postpass_|comment_author_|wp-settings-|woocommerce_|wp_woocommerce_session_)/;
export const PAGE_CACHE_NO_PATH = /^\/(wp-admin|wp-login\.php|wp-json|wp-cron\.php|wp-comments-post\.php|cart|checkout|my-account|wc-api|skyphusion-invoice|_)/;
export const PAGE_CACHE_NO_PARAM = ['rest_route', 'wc-ajax', 'add-to-cart', 'preview', 'nocache', 'customize_changeset_uuid', 'wc-api'];

const hasWpCookie = (req) => WP_COOKIE.test(req.headers.get('cookie') || '');

/** A stored copy can exist for this URL and method: the cache is on, a GET or HEAD, and no excluded path or param. */
export function pageCopyShape(req, url, env) {
	return (
		Number(env.PAGE_CACHE_TTL || 120) > 0 &&
		(req.method === 'GET' || req.method === 'HEAD') &&
		!PAGE_CACHE_NO_PATH.test(url.pathname) &&
		!PAGE_CACHE_NO_PARAM.some((k) => url.searchParams.has(k))
	);
}

/** The request goes to the cached Pages entrypoint (the guest's copy). */
export function pageCacheRoute(req, url, env) {
	return (
		pageCopyShape(req, url, env) &&
		!hasWpCookie(req) &&
		!req.headers.get('upgrade') &&
		!req.headers.has('authorization') &&
		// An operator request never goes to the cached entrypoint (perf-headers.mjs).
		!isOperatorRequest(req) &&
		// #1277 probe: its direct and render arms render in the gateway's own (placed) fetch handler.
		!['direct', 'render', 'object', 'object-new'].includes(probeArm(req, env))
	);
}

/** The store decision's request side (pageCacheHeaders in index.js adds the answer's side). #1371 unifies it with the route. */
export function storeRequestSide(req, url, env) {
	return pageCopyShape(req, url, env) && !hasWpCookie(req) && !req.headers.has('authorization');
}

/**
 * #1328: the request is for a URL that can have a stored copy, but it is NOT the request that copy was made for (a WP
 * cookie, authorization, an operator, an upgrade, a probe arm), so it is answered by the gateway.
 */
export function missesStoredCopy(req, url, env) {
	return pageCopyShape(req, url, env) && !pageCacheRoute(req, url, env);
}

/**
 * #1328: on a busy answer (a 503 with x-overloaded: the php-lock shed, the start-by refusal, the overflow held-block),
 * the edge serves a stored copy of the URL STALE in its place, even to a request that went to the gateway and never to
 * the cached entrypoint (forced on cf759hl, 3 of 3: a cart-cookie GET got the guest's page). A 429 reaches the client
 * as is (3 of 3). So for missesStoredCopy, the busy answer is a 429: the same body and headers, Retry-After included.
 * Every other answer is returned untouched, the same object. Guests keep their stale copy on a shed.
 */
export function busyAnswerFor(req, url, env, resp) {
	if (!resp || resp.status !== 503 || resp.headers.get('x-overloaded') !== '1') return resp;
	if (!missesStoredCopy(req, url, env)) return resp;
	return new Response(resp.body, { status: 429, statusText: 'Too Many Requests', headers: resp.headers });
}
