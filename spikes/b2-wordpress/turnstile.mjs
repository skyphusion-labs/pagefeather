// Pure helpers for the Turnstile bot-challenge op (issue #250). index.js imports
// these for turnstileOp and the config gate; tests/turnstile.test.mjs tests them.
// verifyToken is the one seam that calls Cloudflare siteverify, so the Worker op
// and the box test run the exact same request. No module side effects, so both can
// import without booting a Worker.
import { createHash, randomUUID } from 'node:crypto';

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
// URLSearchParams. remoteip and idempotencyKey are optional.
export function siteverifyForm(secret, token, remoteip, idempotencyKey) {
	const form = new URLSearchParams();
	form.set('secret', String(secret == null ? '' : secret));
	form.set('response', String(token == null ? '' : token));
	if (remoteip) form.set('remoteip', String(remoteip));
	// The same key on a retry makes Cloudflare answer it as the first try (#351).
	if (idempotencyKey) form.set('idempotency_key', String(idempotencyKey));
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
// the front Worker (preverifyTurnstile in index.js), the in-Worker variant of
// turnstileOp and the box test all call it, so they cannot drift.
//   - An empty token never reaches the network and returns success:false with the
//     missing-input-response code, exactly as Cloudflare would.
//   - A network failure, a timeout or a reply that is not an answer returns
//     success:false with error set, so the caller can tell an infrastructure outage
//     from a token that genuinely failed.
//   - An outage is tried once more (#351), with the same idempotency_key, so Cloudflare
//     answers the retry as it would have answered the first try and does not refuse the
//     token as a duplicate. A token that siteverify answered is never retried.
// opts.fetchImpl lets a unit test inject a stub; it defaults to the global fetch.
// opts.timeoutMs is the budget for ALL tries (default 10s, clamped 1s..30s), split evenly
// between them (at least 500 ms each). opts.tries is 1 or 2 (default 2).
// opts.idempotencyKey defaults to a new UUID per call.
// opts.expect ({ hostname, action }) is passed to readSiteverify. It is ignored for
// a test secret key (isTestSecret), whose replies never carry the real values.
// The reply also carries tries (how many requests were sent).
export async function verifyToken(secret, token, remoteip, opts) {
	const o = opts || {};
	const doFetch = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
	if (!token) return { success: false, codes: ['missing-input-response'] };
	if (!secret) return { success: false, codes: ['missing-input-secret'], error: 'no secret' };
	if (!doFetch) return { success: false, codes: [], error: 'no fetch' };
	const timeoutMs = Math.max(1000, Math.min(30000, Number(o.timeoutMs || 10000)));
	const tries = o.tries === 1 ? 1 : 2;
	const perTryMs = Math.max(500, Math.floor(timeoutMs / tries));
	const key = String(o.idempotencyKey || newIdempotencyKey());
	const body = siteverifyForm(secret, token, remoteip, key).toString();
	let out;
	for (let i = 1; i <= tries; i++) {
		out = await verifyOnce(doFetch, body, perTryMs, isTestSecret(secret) ? null : o.expect);
		out.tries = i;
		if (!out.error) break; // siteverify answered: never retried
	}
	return out;
}

// One siteverify request with its own timeout. The timer is cleared on every path.
async function verifyOnce(doFetch, body, timeoutMs, expect) {
	let timer;
	try {
		const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs); });
		const r = await Promise.race([
			doFetch(TURNSTILE_SITEVERIFY_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body,
			}),
			timeout,
		]);
		if (r && r.__timeout) return { success: false, codes: [], error: 'timeout' };
		let json = null;
		try { json = await r.json(); } catch (_) {}
		const out = readSiteverify(r && r.ok, json, expect);
		// Unreachable unless siteverify answered: success:false, or an HTTP 200 with
		// success:true that then failed the hostname or action check. A failed check is
		// a failed token, never an outage.
		const answered = !!(json && (json.success === false || (r && r.ok && json.success === true)));
		if (!out.success && !answered) out.error = 'verify_unreachable';
		return out;
	} catch (e) {
		return { success: false, codes: [], error: String(e && e.message ? e.message : e).slice(0, 160) };
	} finally {
		clearTimeout(timer);
	}
}

function newIdempotencyKey() {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === 'function') return c.randomUUID();
	return randomUUID();
}

// ---- The front Worker verifies; the object only reads the answer (#351). ----
//
// A Durable Object holds an outgoing fetch until the writes made before it are confirmed. A
// login and a Store API checkout write BEFORE their Turnstile gate runs, so a verify from inside
// the object waited for those writes in the middle of the PHP run. On a store whose object isolate
// is at its memory limit, the reset landed in that wait and every write after it was lost
// (tsv1113w, 2026-11-13: 10 of 10 valid logins answered 500 x-write-loss 3; the design and the
// timing are on #351). So the stateless front Worker verifies a gated POST before it reaches the
// object, and hands the answer over in TURNSTILE_RESULT_HEADER. The object takes the header off
// before PHP sees the request and keeps it for that one PHP run (TurnstileSlot). turnstileOp then
// answers from it without any fetch or wait. The front Worker always deletes a header of that name
// that came from the client, so a client cannot supply an answer.

export const TURNSTILE_RESULT_HEADER = 'x-pf-turnstile-result';

// The front Worker's side: drop any copy the client sent, then set this Worker's own answer (or
// none). Called on every request it forwards to the object, gated or not.
export function setResultHeader(headers, value) {
	headers.delete(TURNSTILE_RESULT_HEADER);
	if (value) headers.set(TURNSTILE_RESULT_HEADER, value);
}

// The object's side: read the answer and take it off, so PHP never sees the header.
export function takeResultHeader(headers) {
	const v = headers.get(TURNSTILE_RESULT_HEADER);
	headers.delete(TURNSTILE_RESULT_HEADER);
	return v;
}

// The Store API extension namespace of the block checkout (php/turnstile-forms.php
// SKYPHUSION_TURNSTILE_BLOCK_NS).
export const TURNSTILE_BLOCK_NS = 'skyphusion-turnstile';

// The field the classic forms post (the widget's hidden input).
export const TURNSTILE_FIELD = 'cf-turnstile-response';

// A gated body larger than this is not read: it gets no answer, so its gate fails closed.
// A comment is at most 64 KiB of text; a login or a checkout is far smaller.
export const TURNSTILE_MAX_BODY = 1024 * 1024;

const STORE_CHECKOUT = /^\/wc\/store(\/v1)?\/checkout\/?$/;

// The budget for one front verify, both tries together: TURNSTILE_TIMEOUT_MS (default 10 s,
// clamped 1 s to 30 s).
export function turnstileTimeoutMs(env) {
	return Math.max(1000, Math.min(30000, Number((env && env.TURNSTILE_TIMEOUT_MS) || 10000)));
}

// Which gated form a request is, or '' when it is none, or its form is switched off:
//   'login'    POST /wp-login.php                       (TURNSTILE_LOGIN)
//   'comments' POST /wp-comments-post.php               (TURNSTILE_COMMENTS)
//   'woo'      POST /?wc-ajax=checkout, classic checkout (TURNSTILE_WOO)
//   'store'    POST Store API checkout, /wp-json/wc/store[/v1]/checkout or ?rest_route= (TURNSTILE_WOO)
// A request that matches none gets no answer; if its PHP gate still runs, it fails closed.
export function turnstileRoute(env, method, url) {
	if (String(method || '').toUpperCase() !== 'POST' || !turnstileEnabled(env)) return '';
	const forms = turnstileForms(env);
	const path = url.pathname;
	if (path === '/wp-login.php') return forms.login ? 'login' : '';
	if (path === '/wp-comments-post.php') return forms.comments ? 'comments' : '';
	if (!forms.woo) return '';
	if (url.searchParams.get('wc-ajax') === 'checkout') return 'woo';
	const rest = url.searchParams.get('rest_route') || (path.startsWith('/wp-json/') ? path.slice(8) : '');
	if (STORE_CHECKOUT.test(rest)) return 'store';
	return '';
}

// The token of a gated request, read from a CLONE of it (the caller forwards the original). ''
// when the body is missing, too large, not the expected type, or has no token.
export async function readGatedToken(route, req) {
	try {
		const len = Number(req.headers.get('content-length'));
		if (!len || len > TURNSTILE_MAX_BODY) return '';
		const ct = String(req.headers.get('content-type') || '').toLowerCase();
		let token = '';
		if (route === 'store') {
			if (!ct.includes('json')) return '';
			const j = JSON.parse(await req.text());
			const ext = j && j.extensions && j.extensions[TURNSTILE_BLOCK_NS];
			token = ext && typeof ext.token === 'string' ? ext.token : '';
		} else if (ct.includes('application/x-www-form-urlencoded')) {
			token = new URLSearchParams(await req.text()).get(TURNSTILE_FIELD) || '';
		} else if (ct.includes('multipart/form-data')) {
			const v = (await req.formData()).get(TURNSTILE_FIELD);
			token = typeof v === 'string' ? v : '';
		}
		return String(token).trim();
	} catch (_) {
		return '';
	}
}

// SHA-256 of a token, hex. Synchronous (node:crypto), so the object never waits to compare.
export function tokenHash(token) {
	return createHash('sha256').update(String(token == null ? '' : token).trim()).digest('hex');
}

// The header value the front Worker sends: the verify answer, bound to the token by its hash.
export function encodeResult(res, token) {
	const r = res || {};
	const out = { success: r.success === true, codes: Array.isArray(r.codes) ? r.codes.slice(0, 8).map((c) => String(c).slice(0, 64)) : [], tokenHash: tokenHash(token) };
	if (r.error) out.error = String(r.error).slice(0, 160);
	return JSON.stringify(out);
}

// Parse a header value back; null for anything that is not a well-formed answer.
export function decodeResult(value) {
	if (typeof value !== 'string' || value === '') return null;
	try {
		const j = JSON.parse(value);
		if (!j || typeof j !== 'object' || typeof j.success !== 'boolean' || typeof j.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(j.tokenHash)) return null;
		const out = { success: j.success, codes: Array.isArray(j.codes) ? j.codes.map(String) : [], tokenHash: j.tokenHash };
		if (j.error) out.error = String(j.error);
		return out;
	} catch (_) {
		return null;
	}
}

// The answer for ONE PHP run in the object. set() at the start of the run with the header the
// front Worker sent, clear() at its end. take(token) answers once: the token must hash to the one
// the front Worker verified, and a second take in the same run fails, as a spent token does at
// Cloudflare. With no answer, a bad header, a different token or a second take, it fails CLOSED
// with a code and no error field (a failed token, never an outage).
export class TurnstileSlot {
	constructor() { this.clear(); }
	set(headerValue) { this.result = decodeResult(headerValue); this.used = false; }
	clear() { this.result = null; this.used = false; }
	take(token) {
		if (!token) return { success: false, codes: ['missing-input-response'] };
		if (!this.result) return { success: false, codes: ['not-preverified'] };
		if (this.used) return { success: false, codes: ['already-used'] };
		if (tokenHash(token) !== this.result.tokenHash) return { success: false, codes: ['token-mismatch'] };
		this.used = true;
		const out = { success: this.result.success, codes: this.result.codes.slice() };
		if (this.result.error) out.error = this.result.error;
		return out;
	}
}

// The Retry-After a Store API outage answer gets (#351): the object answered 503 for the block
// checkout because the verifier was unreachable, and nothing was written, so a retry is safe.
export const TURNSTILE_RETRY_AFTER_S = '5';
export function retryAfterFor(route, preverified, status) {
	return route === 'store' && status === 503 && preverified && preverified.error ? TURNSTILE_RETRY_AFTER_S : '';
}
