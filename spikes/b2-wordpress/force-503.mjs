// #1328 (the lead's forced-503 test; a TEST build, NOT for merge). When the gateway answers 503 for a URL that has a stored
// guest copy, does the cache serve that copy STALE, to a request with cart cookies too? This makes the engine answer its
// OWN php-lock shed response (phpShedResponse: 503, Retry-After) for one request, so the client's view can be read.
// Only with the site var FORCE_503=on AND a valid spike token AND the header x-pf-force-503: 1.
export const FORCE_503_HEADER = 'x-pf-force-503';
export function force503Allowed(env, spikeOk, req) {
	return Boolean(spikeOk) && !!env && env.FORCE_503 === 'on' && !!req && req.headers.get(FORCE_503_HEADER) === '1';
}

// The lead's 3-case test: x-pf-force-503 is 1 or 503 for the engine's shed 503, or 429 for the same answer as a 429 (does
// a 4xx escape Cloudflare's stale-on-error path?). Anything else: no forcing.
export function force503Mode(env, spikeOk, req) {
	if (!Boolean(spikeOk) || !env || env.FORCE_503 !== 'on' || !req) return null;
	const v = req.headers.get(FORCE_503_HEADER);
	return v === '1' || v === '503' ? 503 : v === '429' ? 429 : null;
}
/** The shed answer with status 429: the same body and headers. */
export function busy429(shed) {
	return new Response(shed.body, { status: 429, headers: shed.headers });
}
