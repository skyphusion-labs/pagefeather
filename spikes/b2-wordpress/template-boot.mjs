// #962: the email editor stays on its progress bar until the templates list
// returns. PHP runs one request at a time. templates/lookup takes several
// seconds. In arrival order it runs first, so the list is still open at the
// 10 s click. The list (context=edit and the fetch-all query) and a single
// template GET go ahead of other queued boot calls. Lookup does not.
// An idle lookup waits one short beat so a list sent in the same burst can
// take the lock first. A lookup that is already running is not stopped.

export const TEMPLATE_LOOKUP_YIELD_MS = 50;

// The REST path, pretty (/wp-json/wp/v2/...) or plain (?rest_route=).
export function templateRestPath(url) {
	const raw = url.searchParams.get('rest_route') || (url.pathname.startsWith('/wp-json/') ? url.pathname.slice(8) : '');
	const path = String(raw).split('?')[0];
	return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

export function isTemplateLookupGet(method, url) {
	return method === 'GET' && templateRestPath(url) === '/wp/v2/templates/lookup';
}

// The collection, and one template by id. Not lookup.
export function isTemplateEditorGet(method, url) {
	if (method !== 'GET') return false;
	const path = templateRestPath(url);
	if (path === '/wp/v2/templates') return true;
	return path.startsWith('/wp/v2/templates/') && path !== '/wp/v2/templates/lookup';
}

// 1: grant this GET before queued boot calls. 0: arrival order.
export function templateQueuePriority(method, url) {
	return isTemplateEditorGet(method, url) ? 1 : 0;
}

// Ms to wait before an idle lookup takes the lock. 0: take it now.
export function templateLookupYield(method, url, lock) {
	if (!isTemplateLookupGet(method, url)) return 0;
	if (!lock || lock.running || lock.waiting) return 0;
	return TEMPLATE_LOOKUP_YIELD_MS;
}

// Ms to wait before the Worker forwards a lookup. The Worker cannot see the
// object lock, so every lookup waits. A list sent with it is forwarded first.
export function templateLookupForwardYield(method, url) {
	return isTemplateLookupGet(method, url) ? TEMPLATE_LOOKUP_YIELD_MS : 0;
}
