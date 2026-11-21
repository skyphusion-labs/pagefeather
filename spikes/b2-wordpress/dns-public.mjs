// #1156: real host resolution for WordPress's URL safety check. Inside the engine gethostbyname() returns emscripten's
// SYNTHETIC addresses (172.29.x.x, its socket emulation's DNS), which are in 172.16.0.0/12, so wp_http_validate_url
// took every external host for a private one and refused it (cldup.com, wordpress.org: measured locally). Core asks
// the http_request_host_is_external filter for a private-looking address; php/http-external-dns.php asks this module
// (through the bridge) only when the address is the synthetic one. A host counts as external only when EVERY address
// it really resolves to is public: stock WordPress's private ranges, plus loopback, link-local, CGNAT and the IPv6
// private ranges. A failed lookup, no address, or one private address: not external (core keeps its refusal).

// #1156 review: privacy is the primary goal, so the ONLY resolver is Cloudflare's own DNS over HTTPS (the platform the
// site already runs on), never a third party.
export const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const DOH = DOH_URL;
// #1156 review: a lookup that takes longer than this is a refusal, as a failed lookup is on stock.
export const DOH_TIMEOUT_MS = 1500;
const TTL_MAX_MS = 300_000;
const NEG_MS = 60_000;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** The engine's synthetic DNS range (emscripten): 172.29.0.0/16. */
export function isSyntheticAddress(ip) {
	return /^172\.29\.\d{1,3}\.\d{1,3}$/.test(String(ip || ''));
}

function v4(ip) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (!m) return null;
	const p = m.slice(1).map(Number);
	return p.every((n) => n <= 255) ? p : null;
}

/** Is this address on the public internet? Anything unparsable is not. */
export function isPublicAddress(ip) {
	const s = String(ip || '').trim().toLowerCase();
	const p = v4(s);
	if (p) {
		const [a, b] = p;
		if (a === 0 || a === 10 || a === 127) return false;
		if (a === 169 && b === 254) return false;
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && b === 168) return false;
		if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
		if (a === 192 && b === 0 && p[2] === 0) return false;
		if (a >= 224) return false; // multicast and reserved
		return true;
	}
	if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return false;
	if (s === '::' || s === '::1') return false;
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
	if (mapped) return isPublicAddress(mapped[1]);
	if (/^f[cd]/.test(s)) return false; // fc00::/7
	if (/^fe[89ab]/.test(s)) return false; // fe80::/10
	if (/^ff/.test(s)) return false; // multicast
	return true;
}

async function lookup(fetchFn, host, type, signal) {
	const res = await fetchFn(DOH + '?name=' + encodeURIComponent(host) + '&type=' + type, { headers: { accept: 'application/dns-json' }, signal });
	if (!res || !res.ok) throw new Error('doh status ' + (res && res.status));
	const j = await res.json();
	const want = type === 'A' ? 1 : 28;
	const ans = Array.isArray(j && j.Answer) ? j.Answer.filter((x) => x && x.type === want && typeof x.data === 'string') : [];
	return { addrs: ans.map((x) => x.data), ttl: ans.reduce((m, x) => Math.min(m, Number(x.TTL) || 0), Infinity) };
}

/** Does `host` resolve, and only to public addresses? Cached per host (the record TTL, at most 5 min; a refusal 1 min). */
export async function hostIsPublic(host, { fetch: fetchFn = globalThis.fetch, cache = DEFAULT_CACHE, now = Date.now(), timeoutMs = DOH_TIMEOUT_MS } = {}) {
	const h = String(host || '').toLowerCase().replace(/\.$/, '');
	if (!HOST_RE.test(h)) return false;
	const hit = cache.get(h);
	if (hit && hit.exp > now) return hit.ok;
	let ok = false, ttlMs = NEG_MS;
	try {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(new Error('doh timeout')), timeoutMs);
		let a, aaaa;
		try {
			[a, aaaa] = await Promise.all([lookup(fetchFn, h, 'A', ac.signal), lookup(fetchFn, h, 'AAAA', ac.signal).catch(() => ({ addrs: [], ttl: Infinity }))]);
		} finally {
			clearTimeout(timer);
		}
		const all = a.addrs.concat(aaaa.addrs);
		ok = all.length > 0 && all.every(isPublicAddress);
		const ttl = Math.min(a.ttl, aaaa.ttl);
		if (ok) ttlMs = Math.min(TTL_MAX_MS, Number.isFinite(ttl) ? Math.max(1, ttl) * 1000 : TTL_MAX_MS);
	} catch {
		ok = false;
	}
	if (cache.size > 512) cache.clear();
	cache.set(h, { ok, exp: now + ttlMs });
	return ok;
}
const DEFAULT_CACHE = new Map();
