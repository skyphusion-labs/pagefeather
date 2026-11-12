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

// The action the widget carries (php/turnstile-forms.php data-action). A token
// from this site's widget comes back from siteverify with this action.
export const TURNSTILE_ACTION = 'turnstile-spin-v1';

// The documented Turnstile test secret keys (1x... passes, 2x... fails, 3x...
// reports a spent token). Their replies always name example.com as the hostname
// and carry no action, so the hostname and action checks are skipped for them.
export function isTestSecret(secret) {
	return typeof secret === 'string' && /^[123]x0{31}AA$/.test(secret);
}

// The host a token must have been solved on: the lower-case hostname of the
// site origin (SITE_ORIGIN). '' when the origin is missing or not a URL.
export function siteHost(origin) {
	try {
		return new URL(String(origin || '')).hostname.toLowerCase();
	} catch {
		return '';
	}
}

// Normalise a siteverify answer to { success, codes }. success is true only when
// Cloudflare returns the literal success:true; every other shape is false so a
// caller fails closed. With expect, success also needs the reply's hostname to be
// expect.hostname and its action to be expect.action (each when given); a token
// solved on another host, or for another action, fails with the code
// hostname-mismatch or action-mismatch.
export function readSiteverify(httpOk, json, expect) {
	let success = !!(httpOk && json && json.success === true);
	const codes = json && Array.isArray(json['error-codes']) ? json['error-codes'].slice() : [];
	if (success && expect) {
		if (expect.hostname && String(json.hostname || '').toLowerCase() !== expect.hostname) {
			success = false;
			codes.push('hostname-mismatch');
		}
		if (expect.action && json.action !== expect.action) {
			success = false;
			codes.push('action-mismatch');
		}
	}
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
// opts.expect ({ hostname, action }) is passed to readSiteverify. It is ignored for
// a test secret key (isTestSecret), whose replies never carry the real values.
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
		const out = readSiteverify(r && r.ok, json, isTestSecret(secret) ? null : o.expect);
		// Unreachable unless siteverify answered: success:false, or an HTTP 200 with
		// success:true that then failed the hostname or action check. A failed check is
		// a failed token, never an outage, so a site that fails open on an outage still
		// rejects it.
		const answered = !!(json && (json.success === false || (r && r.ok && json.success === true)));
		if (!out.success && !answered) out.error = 'verify_unreachable';
		return out;
	} catch (e) {
		return { success: false, codes: [], error: String(e && e.message ? e.message : e).slice(0, 160) };
	}
}
