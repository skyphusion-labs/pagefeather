// #1277 option 1: on approach A, Pages hands a page-cache MISS render to the gateway's PLACED fetch handler. Smart
// Placement places fetch handlers, not named entrypoints, so a render inside Pages ran PHP at the ingress colo, far
// from the database (about 105 ms per query from DFW and LAX against about 18 placed, #1277). The marked request
// renders in the gateway (pageCacheRoute never sends it back to Pages), and Pages caches the answer as before.
// A client that sends the marker itself gets an uncached render in the placed handler: the same as a WordPress cookie
// or a no-cache parameter already gets, so it opens nothing new.
export const PAGES_RENDER_HEADER = 'x-pf-pages-render';

// Approach A: PHP runs in the Worker (not in an object), with the database outside. On b-dosql and b-do Pages already
// forwards to the object, so there is nothing to place.
export function rendersInWorker(env) {
	return !!env && env.PHP_IN_DO !== 'on' && env.DB_IN_DO !== 'on';
}

export function placedRenderRequest(req) {
	const h = new Headers(req.headers);
	h.set(PAGES_RENDER_HEADER, '1');
	// #1277 arm c (experiment): ask that no cache layer on the loopback hop look up or store this request.
	return new Request(req, { headers: h, cache: 'no-store' });
}

export function isPlacedRender(req) {
	return !!(req && req.headers && req.headers.get(PAGES_RENDER_HEADER) === '1');
}

// #1328: the gateway's answer to a placed render is never storable. Before #1296 the default entrypoint never answered
// with a storable cloudflare-cdn-cache-control (Pages' cache consumed it). Since #1296 it did, and a cookieless guest
// render reached shoppers with cart cookies (cf759hl /classic-cart/ HIT, no x-entrypoint). The directive and the purge
// tag travel to Pages in these private headers; Pages, the one cached entrypoint, restores them on the answer it caches.
export const PLACED_CDN_CC_HEADER = 'x-pf-placed-cdn-cc';
export const PLACED_CACHE_TAG_HEADER = 'x-pf-placed-cache-tag';
export function sealPlacedCache(headers, cdnCc, tag) {
	headers.set('cloudflare-cdn-cache-control', 'no-store');
	headers.delete('cache-tag');
	headers.set(PLACED_CDN_CC_HEADER, cdnCc);
	headers.set(PLACED_CACHE_TAG_HEADER, tag);
}
// Returns whether a storable directive was restored. With none (not cacheable), the gateway's no-store stays.
export function unsealPlacedCache(headers) {
	const cc = headers.get(PLACED_CDN_CC_HEADER);
	const tag = headers.get(PLACED_CACHE_TAG_HEADER);
	headers.delete(PLACED_CDN_CC_HEADER);
	headers.delete(PLACED_CACHE_TAG_HEADER);
	if (!cc) return false;
	headers.set('cloudflare-cdn-cache-control', cc);
	if (tag) headers.set('cache-tag', tag);
	return true;
}
