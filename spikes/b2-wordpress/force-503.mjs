// #1328 (the lead's forced-503 test; a TEST build, NOT for merge). When the gateway answers 503 for a URL that has a stored
// guest copy, does the cache serve that copy STALE, to a request with cart cookies too? This makes the engine answer its
// OWN php-lock shed response (phpShedResponse: 503, Retry-After) for one request, so the client's view can be read.
// Only with the site var FORCE_503=on AND a valid spike token AND the header x-pf-force-503: 1.
export const FORCE_503_HEADER = 'x-pf-force-503';
export function force503Allowed(env, spikeOk, req) {
	return Boolean(spikeOk) && !!env && env.FORCE_503 === 'on' && !!req && req.headers.get(FORCE_503_HEADER) === '1';
}
