// #1277 option-1 probe (a MEASUREMENT, off by default; only for a throwaway site). Does a page-cache MISS render that
// Pages (a named entrypoint, which Smart Placement does not place) hands to the gateway's fetch handler through
// ctx.exports.default.fetch run at the placed colo? The rule was set before the data: #1277 issuecomment-7064641735.
// On only when PLACEMENT_PROBE_KEY (16 characters or more; a wrangler secret) is set, and only for a request that
// carries x-pf-placement-probe: <arm>:<key>. It cannot use the spike token: an operator request never reaches Pages
// (pageCacheRoute). Arms:
//   pages   Pages renders itself (today's MISS path)
//   loop    Pages hands the render to ctx.exports.default.fetch (option 1); the gateway sees arm render
//   direct  the gateway's fetch handler renders, never through Pages (the control)
//   object      the render runs on the existing pool object ovf-0 (a Durable Object runs where it was first made)
//   object-new  the render runs on a fresh probe-only object, made with the pool's location hint
//               (pfprobe-<PLACEMENT_PROBE_OBJECT>; a new value makes a new object; #1277 issuecomment-7064796127)
// Each rendering side reports where its code ran from a cdn-cgi/trace subrequest. Every probe answer is no-store.
export const PROBE_HEADER = 'x-pf-placement-probe';
const ARMS = new Set(['pages', 'loop', 'direct', 'render', 'object', 'object-new']);
// Set by an object on its own inner call, so it traces its colo once (no recursion).
export const PROBE_TRACED_HEADER = 'x-pf-probe-traced';
const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

function sameString(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
}

export function probeArm(req, env) {
	const key = env && env.PLACEMENT_PROBE_KEY;
	if (typeof key !== 'string' || key.length < 16) return null;
	const v = req && req.headers ? req.headers.get(PROBE_HEADER) : null;
	if (!v) return null;
	const i = v.indexOf(':');
	if (i <= 0) return null;
	const arm = v.slice(0, i);
	if (!ARMS.has(arm)) return null;
	return sameString(v.slice(i + 1), key) ? arm : null;
}

export function coloFromTrace(text) {
	const m = /^colo=([A-Z]{3})$/m.exec(String(text || ''));
	return m ? m[1] : null;
}

export async function traceColo(fetchFn = fetch, timeoutMs = 3000) {
	let timer;
	try {
		const r = await Promise.race([
			fetchFn(TRACE_URL),
			new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), timeoutMs); }),
		]);
		const colo = coloFromTrace(await r.text());
		return colo || 'error:no-colo';
	} catch (e) {
		return 'error:' + String((e && e.message) || e).slice(0, 60);
	} finally {
		clearTimeout(timer);
	}
}

export function renderRequest(req, key) {
	const h = new Headers(req.headers);
	h.set(PROBE_HEADER, 'render:' + key);
	return new Request(req, { headers: h });
}

// The object-new arm's object name: never a pool name (ovf-*), [a-z0-9-]{1,16} or the default 'a'.
export function probeObjectName(env) {
	const v = env && typeof env.PLACEMENT_PROBE_OBJECT === 'string' ? env.PLACEMENT_PROBE_OBJECT : '';
	return 'pfprobe-' + (/^[a-z0-9-]{1,16}$/.test(v) ? v : 'a');
}
