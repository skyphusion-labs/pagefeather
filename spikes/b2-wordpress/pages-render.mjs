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
	return new Request(req, { headers: h });
}

export function isPlacedRender(req) {
	return !!(req && req.headers && req.headers.get(PAGES_RENDER_HEADER) === '1');
}
