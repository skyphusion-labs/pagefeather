// Pure helpers for the Turnstile bot-challenge op (issue #250). index.js imports
// these for turnstileOp and the config gate; tests/turnstile.test.mjs tests them.
// verifyToken is the one seam that calls Cloudflare siteverify, so the Worker op
// and the box test run the exact same request. No module side effects, so both can
// import without booting a Worker.

// Cloudflare Turnstile server-side verification endpoint. The secret and the token
// go here in a POST; the browser never calls it (the token is verified server side).
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// A Turnstile site key is public and ships in the page. It is a short token of
// letters, digits, underscores and hyphens (for example 1x00000000000000000000AA,
// the documented always-passes test key). Anything else returns '' so a malformed
// binding never reaches a define in wp-runtime.php.
export function sanitizeSiteKey(key) {
	return typeof key === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(key) ? key : '';
}

// Whether index.js should inject define('SKYPHUSION_TURNSTILE', true): the secret
// binding and a valid public site key are both present, and TURNSTILE is not turned
// off. Binding based, so there is no zone or profile requirement: this works on a
// workers.dev host. TURNSTILE=off is the master off switch.
export function turnstileEnabled(env) {
	return !!(
		env &&
		env.TURNSTILE_SECRET &&
		sanitizeSiteKey(env.TURNSTILE_SITEKEY) &&
		env.TURNSTILE !== 'off'
	);
}

// Which of the three forms get the challenge, each independently switchable. Every
// form defaults on when the feature is on; TURNSTILE_LOGIN, TURNSTILE_COMMENTS or
// TURNSTILE_WOO set to off turns that one form off while the others stay on.
export function turnstileForms(env) {
	const e = env || {};
	return {
		login: e.TURNSTILE_LOGIN !== 'off',
		comments: e.TURNSTILE_COMMENTS !== 'off',
		woo: e.TURNSTILE_WOO !== 'off',
	};
}

// The application/x-www-form-urlencoded body for a siteverify POST, as a
// URLSearchParams. remoteip is optional (Cloudflare accepts the request without it).
export function siteverifyForm(secret, token, remoteip) {
	const form = new URLSearchParams();
	form.set('secret', String(secret == null ? '' : secret));
	form.set('response', String(token == null ? '' : token));
	if (remoteip) form.set('remoteip', String(remoteip));
	return form;
}

// Normalise a siteverify answer to { success, codes }. success is true only when
// Cloudflare returns the literal success:true; every other shape is false so a
// caller fails closed.
export function readSiteverify(httpOk, json) {
	const success = !!(httpOk && json && json.success === true);
	const codes = json && Array.isArray(json['error-codes']) ? json['error-codes'] : [];
	return { success, codes };
}

// Verify a token against Cloudflare siteverify. This is the single network seam:
// turnstileOp in the Worker and the box test both call it, so they cannot drift.
//   - An empty token never reaches the network and returns success:false with the
//     missing-input-response code, exactly as Cloudflare would.
//   - A network failure or timeout returns success:false with error set, so the
//     caller can tell an infrastructure outage (which a site may choose to let
//     through) from a token that genuinely failed (which it never should).
// opts.fetchImpl lets a unit test inject a stub; it defaults to the global fetch.
// opts.timeoutMs bounds the call (default 10s, clamped 1s..30s).
export async function verifyToken(secret, token, remoteip, opts) {
	const o = opts || {};
	const doFetch = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
	if (!token) return { success: false, codes: ['missing-input-response'] };
	if (!secret) return { success: false, codes: ['missing-input-secret'], error: 'no secret' };
	if (!doFetch) return { success: false, codes: [], error: 'no fetch' };
	const timeoutMs = Math.max(1000, Math.min(30000, Number(o.timeoutMs || 10000)));
	try {
		const timeout = new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), timeoutMs));
		const r = await Promise.race([
			doFetch(TURNSTILE_SITEVERIFY_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: siteverifyForm(secret, token, remoteip).toString(),
			}),
			timeout,
		]);
		if (r && r.__timeout) return { success: false, codes: [], error: 'timeout' };
		let json = null;
		try { json = await r.json(); } catch (_) {}
		const out = readSiteverify(r && r.ok, json);
		if (!out.success && !(json && json.success === false)) out.error = 'verify_unreachable';
		return out;
	} catch (e) {
		return { success: false, codes: [], error: String(e && e.message ? e.message : e).slice(0, 160) };
	}
}
