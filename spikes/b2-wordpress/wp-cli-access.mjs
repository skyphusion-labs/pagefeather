// Cloudflare Access JWT and the operator token for POST /_pf/wp-cli (issue #1258).
//
// The Worker checks the signature against the team certs, then aud, exp, and iss.
// The certs URL is https://<team>.cloudflareaccess.com/cdn-cgi/access/certs.
// A failed check is not an error the caller can tell from a missing route.

const CERTS_TTL_MS = 3600 * 1000;
const CERTS_TTL_CAP_MS = 86400 * 1000;

export function accessTeamOk(team) {
	return typeof team === 'string' && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(team);
}

export function accessAudOk(aud) {
	return typeof aud === 'string' && /^[A-Za-z0-9]{16,128}$/.test(aud);
}

export function accessCertsUrl(team) {
	return 'https://' + team + '.cloudflareaccess.com/cdn-cgi/access/certs';
}

export function accessIssuer(team) {
	return 'https://' + team + '.cloudflareaccess.com';
}

export function createCertCache() {
	let slot = null;
	return {
		get(team, now) {
			if (slot && slot.team === team && slot.exp > now) return slot.keys;
			return null;
		},
		set(team, keys, exp) {
			slot = { team, keys, exp };
		},
	};
}

const certCache = createCertCache();

// The local engine check injects its public JWK here. A deploy refuses the var.
// Any other spike token ignores it, so a production secret never takes the test key.
const LOCAL_SPIKE_TOKEN = 'local-spike-token';

export function devKeysFromEnv(env) {
	if (!env || env.SPIKE_TOKEN !== LOCAL_SPIKE_TOKEN) return null;
	const raw = env.WP_CLI_DEV_KEYS_B64;
	if (typeof raw !== 'string' || raw.length === 0 || raw.length > 16384) return null;
	try {
		const json = atob(raw);
		const keys = JSON.parse(json);
		if (!Array.isArray(keys) || keys.length === 0 || keys.length > 4) return null;
		return keys;
	} catch {
		return null;
	}
}

// SHA-256 both strings, then compare the digests. The compare does not stop
// at the first different byte. An empty secret never matches.
export async function timingSafeEqualString(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false;
	const enc = new TextEncoder();
	const [da, db] = await Promise.all([
		crypto.subtle.digest('SHA-256', enc.encode(a)),
		crypto.subtle.digest('SHA-256', enc.encode(b)),
	]);
	const x = new Uint8Array(da);
	const y = new Uint8Array(db);
	let diff = 0;
	for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
	return diff === 0;
}

function b64urlToBytes(s) {
	if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
	const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
	let bin;
	try { bin = atob(b64); } catch { return null; }
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function b64urlJson(s) {
	const bytes = b64urlToBytes(s);
	if (!bytes) return null;
	try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}

function ttlMs(header) {
	const m = /max-age=(\d+)/i.exec(String(header || ''));
	const sec = m ? Number(m[1]) : CERTS_TTL_MS / 1000;
	if (!Number.isFinite(sec) || sec < 0) return CERTS_TTL_MS;
	return Math.min(sec * 1000, CERTS_TTL_CAP_MS);
}

async function loadKeys(team, now, deps) {
	if (Array.isArray(deps.keys)) return deps.keys;
	const cache = deps.cache || certCache;
	const hit = cache.get(team, now);
	if (hit) return hit;
	const fetchImpl = deps.fetch || fetch;
	const res = await fetchImpl(accessCertsUrl(team));
	if (!res || !res.ok) return null;
	const body = await res.json();
	const keys = body && Array.isArray(body.keys) ? body.keys : null;
	if (!keys) return null;
	const header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('cache-control') : '';
	cache.set(team, keys, now + ttlMs(header));
	return keys;
}

function audMatches(aud, want) {
	if (typeof aud === 'string') return aud === want;
	if (!Array.isArray(aud)) return false;
	for (const item of aud) {
		if (item === want) return true;
	}
	return false;
}

function whoFrom(claims) {
	const email = claims.email;
	if (typeof email === 'string' && /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 254) return email;
	const client = claims.common_name;
	if (typeof client === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(client)) return client;
	return '';
}

// { who } when the JWT is valid for this site. null when it is not.
// deps.keys is the test injection. The route does not pass it.
export async function verifyAccessJwt(token, env, deps = {}) {
	try {
		const team = env && env.ACCESS_TEAM;
		const wantAud = env && env.ACCESS_AUD;
		if (!accessTeamOk(team) || !accessAudOk(wantAud)) return null;
		if (typeof token !== 'string' || token.length < 20 || token.length > 16384) return null;
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		const header = b64urlJson(parts[0]);
		if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) return null;
		const now = typeof deps.now === 'function' ? deps.now() : Date.now();
		const keys = await loadKeys(team, now, deps);
		if (!keys) return null;
		const jwk = keys.find((k) => k && k.kid === header.kid && k.kty === 'RSA' && k.n && k.e);
		if (!jwk) return null;
		const key = await crypto.subtle.importKey(
			'jwk',
			{ kty: 'RSA', n: jwk.n, e: jwk.e },
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
			false,
			['verify'],
		);
		const sig = b64urlToBytes(parts[2]);
		if (!sig) return null;
		const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
		const signed = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
		if (!signed) return null;
		const claims = b64urlJson(parts[1]);
		if (!claims || typeof claims !== 'object') return null;
		if (!audMatches(claims.aud, wantAud)) return null;
		const nowSec = Math.floor(now / 1000);
		if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= nowSec) return null;
		if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > nowSec)) return null;
		if (claims.iss !== accessIssuer(team)) return null;
		const who = whoFrom(claims);
		if (!who) return null;
		return { who };
	} catch {
		return null;
	}
}
