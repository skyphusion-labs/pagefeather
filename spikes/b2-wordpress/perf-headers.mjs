// Per-request performance headers (x-oc-stats, x-d1-*, x-db-rows, x-php-ms, server-timing and
// the rest of the list below) describe the runtime: table and cache-group names, statement
// and row counts, per-request timing, the colo and isolate. They are for the operator who
// measures a deploy, so they leave the Worker only on a request that carries the valid
// x-spike-token, or on every request when PERF_HEADERS=on is set. A visitor gets none, and
// the edge cache never stores them with a page.

export const PERF_HEADERS = [
	'x-php-object',
	'x-object-ms',
	'server-timing',
	'x-perf-worker',
	'x-perf-queue',
	'x-perf',
	'x-oc-stats',
	'x-d1-calls',
	'x-d1-ms',
	'x-d1-failures',
	'x-d1-first-failure',
	'x-db-rows',
	'x-db',
	'x-php-ms',
	'x-r2-ops',
	'x-boot',
	'x-boot-origin',
];

export function perfHeadersAllowed(req, env) {
	if (env && env.PERF_HEADERS === 'on') return true;
	const token = env && env.SPIKE_TOKEN;
	return Boolean(token) && req.headers.get('x-spike-token') === token;
}

// Remove the headers above unless the request may see them. A response that carries none of
// them, or a WebSocket upgrade, is returned as is.
export function scrubPerfHeaders(res, allowed) {
	if (allowed || res.webSocket || !PERF_HEADERS.some((h) => res.headers.has(h))) return res;
	const out = new Response(res.body, res);
	for (const h of PERF_HEADERS) out.headers.delete(h);
	return out;
}
