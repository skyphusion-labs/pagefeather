// node --test tests/turnstile.test.mjs
// Unit tests for the Turnstile helpers (issue #250). These are the pure parts
// index.js builds the turnstile op and the config gate from. verifyToken is tested
// with an injected fetch stub, so no network is touched; the box test exercises it
// against the real siteverify endpoint with the documented test keys.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	TURNSTILE_SITEVERIFY_URL,
	sanitizeSiteKey,
	turnstileEnabled,
	turnstileForms,
	siteverifyForm,
	readSiteverify,
	verifyToken,
	isTestSecret,
	siteHost,
	TURNSTILE_ACTION,
	TURNSTILE_RESULT_HEADER,
	TURNSTILE_BLOCK_NS,
	TURNSTILE_MAX_BODY,
	turnstileRoute,
	readGatedToken,
	tokenHash,
	encodeResult,
	decodeResult,
	setResultHeader,
	takeResultHeader,
	TurnstileSlot,
	retryAfterFor,
} from '../turnstile.mjs';
import { readFileSync } from 'node:fs';

// The documented Cloudflare test keys (box test).
const PASS_SITEKEY = '1x00000000000000000000AA';

test('sanitizeSiteKey keeps a valid public key and drops anything else', () => {
	assert.equal(sanitizeSiteKey(PASS_SITEKEY), PASS_SITEKEY);
	assert.equal(sanitizeSiteKey('2x00000000000000000000AB'), '2x00000000000000000000AB');
	assert.equal(sanitizeSiteKey('key_with-safe.chars'), ''); // a dot is not allowed
	assert.equal(sanitizeSiteKey('has space'), '');
	assert.equal(sanitizeSiteKey('"; DROP'), '');
	assert.equal(sanitizeSiteKey(''), '');
	assert.equal(sanitizeSiteKey(undefined), '');
	assert.equal(sanitizeSiteKey('a'.repeat(65)), '');
});

test('the gate is on only with the secret and a valid site key, off switch wins', () => {
	const on = { TURNSTILE_SECRET: 's', TURNSTILE_SITEKEY: PASS_SITEKEY };
	assert.equal(turnstileEnabled(on), true);
	assert.equal(turnstileEnabled({ ...on, TURNSTILE: 'off' }), false);
	assert.equal(turnstileEnabled({ ...on, TURNSTILE_SECRET: '' }), false);
	assert.equal(turnstileEnabled({ ...on, TURNSTILE_SITEKEY: undefined }), false);
	assert.equal(turnstileEnabled({ ...on, TURNSTILE_SITEKEY: 'bad key' }), false);
	assert.equal(turnstileEnabled(undefined), false);
});

test('each form is independently switchable and defaults on', () => {
	assert.deepEqual(turnstileForms({}), { login: true, comments: true, woo: true });
	assert.deepEqual(turnstileForms({ TURNSTILE_LOGIN: 'off' }), { login: false, comments: true, woo: true });
	assert.deepEqual(turnstileForms({ TURNSTILE_COMMENTS: 'off' }), { login: true, comments: false, woo: true });
	assert.deepEqual(turnstileForms({ TURNSTILE_WOO: 'off' }), { login: true, comments: true, woo: false });
	assert.deepEqual(turnstileForms(undefined), { login: true, comments: true, woo: true });
});

test('siteverifyForm carries secret and response, remoteip optional', () => {
	const f = siteverifyForm('sec', 'tok', '203.0.113.7');
	assert.equal(f.get('secret'), 'sec');
	assert.equal(f.get('response'), 'tok');
	assert.equal(f.get('remoteip'), '203.0.113.7');
	assert.equal(siteverifyForm('sec', 'tok').has('remoteip'), false);
	assert.equal(siteverifyForm(null, null).get('secret'), '');
});

test('readSiteverify is true only on an ok response with success:true', () => {
	assert.deepEqual(readSiteverify(true, { success: true }), { success: true, codes: [] });
	assert.deepEqual(readSiteverify(true, { success: false, 'error-codes': ['bad'] }), { success: false, codes: ['bad'] });
	assert.deepEqual(readSiteverify(false, { success: true }), { success: false, codes: [] });
	assert.deepEqual(readSiteverify(true, null), { success: false, codes: [] });
});

test('verifyToken rejects a missing token without touching the network', async () => {
	let called = false;
	const r = await verifyToken('sec', '', null, { fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ success: true }) }; } });
	assert.equal(r.success, false);
	assert.deepEqual(r.codes, ['missing-input-response']);
	assert.equal(called, false);
});

test('verifyToken posts form-encoded to the siteverify URL and passes on success:true', async () => {
	let seen = null;
	const r = await verifyToken('sec', 'good', '203.0.113.7', {
		fetchImpl: async (url, init) => {
			seen = { url, init };
			return { ok: true, json: async () => ({ success: true, 'error-codes': [] }) };
		},
	});
	assert.equal(r.success, true);
	assert.equal(seen.url, TURNSTILE_SITEVERIFY_URL);
	assert.equal(seen.init.method, 'POST');
	assert.match(seen.init.headers['content-type'], /x-www-form-urlencoded/);
	assert.match(seen.init.body, /secret=sec/);
	assert.match(seen.init.body, /response=good/);
});

test('verifyToken fails a bad token with no infra error', async () => {
	const r = await verifyToken('sec', 'bad', null, {
		fetchImpl: async () => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) }),
	});
	assert.equal(r.success, false);
	assert.equal(r.error, undefined); // a genuine fail, not an outage
	assert.deepEqual(r.codes, ['invalid-input-response']);
});

test('verifyToken marks an unreachable verifier as an infra error', async () => {
	const thrown = await verifyToken('sec', 'tok', null, { fetchImpl: async () => { throw new Error('network down'); } });
	assert.equal(thrown.success, false);
	assert.match(thrown.error, /network down/);

	const http500 = await verifyToken('sec', 'tok', null, { fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
	assert.equal(http500.success, false);
	assert.equal(http500.error, 'verify_unreachable');
});

test('verifyToken times out and reports it as an infra error', async () => {
	const r = await verifyToken('sec', 'tok', null, {
		timeoutMs: 1000,
		fetchImpl: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: async () => ({ success: true }) }), 5000)),
	});
	assert.equal(r.success, false);
	assert.equal(r.error, 'timeout');
});

// The token must have been solved on this site's host, by this site's widget.
const EXPECT = { hostname: 'shop.example.co', action: TURNSTILE_ACTION };
const reply = (json) => ({ fetchImpl: async () => ({ ok: true, json: async () => json }), expect: EXPECT });

test('siteHost is the lower-case hostname of the origin', () => {
	assert.equal(siteHost('https://Shop.Example.co/'), 'shop.example.co');
	assert.equal(siteHost(''), '');
	assert.equal(siteHost('not a url'), '');
});

test('the widget action is the data-action the PHP widget renders', () => {
	assert.equal(TURNSTILE_ACTION, 'turnstile-spin-v1');
});

test('a reply for this host and action passes', async () => {
	const r = await verifyToken('sec', 'tok', null, reply({ success: true, hostname: 'Shop.Example.co', action: TURNSTILE_ACTION }));
	assert.equal(r.success, true);
});

test('a reply with a different hostname fails, as a bad token and not an outage', async () => {
	const r = await verifyToken('sec', 'tok', null, reply({ success: true, hostname: 'other.example.co', action: TURNSTILE_ACTION }));
	assert.equal(r.success, false);
	assert.ok(r.codes.includes('hostname-mismatch'));
	assert.equal(r.error, undefined);
});

test('a reply with no hostname fails when a hostname is expected', async () => {
	const r = await verifyToken('sec', 'tok', null, reply({ success: true, action: TURNSTILE_ACTION }));
	assert.equal(r.success, false);
	assert.ok(r.codes.includes('hostname-mismatch'));
});

test('a reply with a different or missing action fails, as a bad token', async () => {
	const other = await verifyToken('sec', 'tok', null, reply({ success: true, hostname: 'shop.example.co', action: 'login' }));
	assert.equal(other.success, false);
	assert.ok(other.codes.includes('action-mismatch'));
	assert.equal(other.error, undefined);
	const none = await verifyToken('sec', 'tok', null, reply({ success: true, hostname: 'shop.example.co' }));
	assert.equal(none.success, false);
	assert.ok(none.codes.includes('action-mismatch'));
});

test('readSiteverify with no expect keeps the old behaviour', () => {
	assert.deepEqual(readSiteverify(true, { success: true, hostname: 'any.example' }), { success: true, codes: [] });
});

test('a documented test secret skips the hostname and action checks', async () => {
	assert.equal(isTestSecret('1x0000000000000000000000000000000AA'), true);
	assert.equal(isTestSecret('2x0000000000000000000000000000000AA'), true);
	assert.equal(isTestSecret('3x0000000000000000000000000000000AA'), true);
	assert.equal(isTestSecret('0x4AAAAAAA-real-secret'), false);
	assert.equal(isTestSecret(undefined), false);
	// A test secret's reply names example.com and carries no action.
	const r = await verifyToken('1x0000000000000000000000000000000AA', 'tok', null, reply({ success: true, hostname: 'example.com' }));
	assert.equal(r.success, true);
});

test('a non-200 reply that says success:true is still an outage, as before', async () => {
	const r = await verifyToken('sec', 'tok', null, { fetchImpl: async () => ({ ok: false, json: async () => ({ success: true }) }), expect: EXPECT });
	assert.equal(r.success, false);
	assert.equal(r.error, 'verify_unreachable');
});

// ---- #351: the front Worker verifies, the object only reads the answer. ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ON = { TURNSTILE_SECRET: 's', TURNSTILE_SITEKEY: PASS_SITEKEY };
const U = (path) => new URL(path, 'https://shop.example.co');

test('siteverifyForm carries the idempotency key when given', () => {
	assert.equal(siteverifyForm('sec', 'tok', null, 'k-1').get('idempotency_key'), 'k-1');
	assert.equal(siteverifyForm('sec', 'tok').has('idempotency_key'), false);
});

test('an outage is retried once with the SAME idempotency key, and the retry can pass', async () => {
	const keys = [];
	let n = 0;
	const r = await verifyToken('sec', 'tok', null, {
		fetchImpl: async (url, init) => {
			keys.push(new URLSearchParams(init.body).get('idempotency_key'));
			if (++n === 1) throw new Error('network down');
			return { ok: true, json: async () => ({ success: true }) };
		},
	});
	assert.equal(r.success, true);
	assert.equal(r.tries, 2);
	assert.equal(keys.length, 2);
	assert.ok(keys[0], 'a key is sent');
	assert.equal(keys[0], keys[1]);
});

test('a token siteverify answered is never retried', async () => {
	let n = 0;
	const r = await verifyToken('sec', 'bad', null, { fetchImpl: async () => { n++; return { ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) }; } });
	assert.equal(r.success, false);
	assert.equal(r.error, undefined);
	assert.equal(n, 1);
	assert.equal(r.tries, 1);
});

test('two timeouts stay inside the one budget and report an outage', async () => {
	let n = 0;
	const t0 = Date.now();
	const r = await verifyToken('sec', 'tok', null, { timeoutMs: 1000, fetchImpl: () => { n++; return new Promise(() => {}); } });
	const ms = Date.now() - t0;
	assert.equal(r.success, false);
	assert.equal(r.error, 'timeout');
	assert.equal(n, 2);
	assert.ok(ms >= 950 && ms < 1500, 'ms ' + ms);
});

test('tries:1 sends one request', async () => {
	let n = 0;
	const r = await verifyToken('sec', 'tok', null, { tries: 1, fetchImpl: async () => { n++; throw new Error('x'); } });
	assert.equal(n, 1);
	assert.equal(r.tries, 1);
	assert.ok(r.error);
});

test('turnstileRoute names each gated POST, honours each switch, and nothing else', () => {
	assert.equal(turnstileRoute(ON, 'POST', U('/wp-login.php')), 'login');
	assert.equal(turnstileRoute(ON, 'POST', U('/wp-login.php?action=login')), 'login');
	assert.equal(turnstileRoute(ON, 'POST', U('/wp-comments-post.php')), 'comments');
	assert.equal(turnstileRoute(ON, 'POST', U('/?wc-ajax=checkout')), 'woo');
	assert.equal(turnstileRoute(ON, 'POST', U('/checkout/?wc-ajax=checkout')), 'woo');
	assert.equal(turnstileRoute(ON, 'POST', U('/wp-json/wc/store/v1/checkout')), 'store');
	assert.equal(turnstileRoute(ON, 'POST', U('/wp-json/wc/store/checkout')), 'store');
	assert.equal(turnstileRoute(ON, 'POST', U('/?rest_route=/wc/store/v1/checkout')), 'store');
	assert.equal(turnstileRoute(ON, 'post', U('/wp-login.php')), 'login');
	// Not gated: other methods, other paths, the draft updates, the batch route.
	assert.equal(turnstileRoute(ON, 'GET', U('/wp-login.php')), '');
	assert.equal(turnstileRoute(ON, 'PUT', U('/wp-json/wc/store/v1/checkout')), '');
	assert.equal(turnstileRoute(ON, 'POST', U('/wp-json/wc/store/v1/batch')), '');
	assert.equal(turnstileRoute(ON, 'POST', U('/wp-json/wc/store/v1/cart/add-item')), '');
	assert.equal(turnstileRoute(ON, 'POST', U('/?wc-ajax=update_order_review')), '');
	assert.equal(turnstileRoute(ON, 'POST', U('/')), '');
	// Switches.
	assert.equal(turnstileRoute({ ...ON, TURNSTILE: 'off' }, 'POST', U('/wp-login.php')), '');
	assert.equal(turnstileRoute({ ...ON, TURNSTILE_SECRET: '' }, 'POST', U('/wp-login.php')), '');
	assert.equal(turnstileRoute({ ...ON, TURNSTILE_LOGIN: 'off' }, 'POST', U('/wp-login.php')), '');
	assert.equal(turnstileRoute({ ...ON, TURNSTILE_COMMENTS: 'off' }, 'POST', U('/wp-comments-post.php')), '');
	assert.equal(turnstileRoute({ ...ON, TURNSTILE_WOO: 'off' }, 'POST', U('/?wc-ajax=checkout')), '');
	assert.equal(turnstileRoute({ ...ON, TURNSTILE_WOO: 'off' }, 'POST', U('/wp-json/wc/store/v1/checkout')), '');
	assert.equal(turnstileRoute({ ...ON, TURNSTILE_LOGIN: 'off' }, 'POST', U('/?wc-ajax=checkout')), 'woo');
});

const formReq = (body, ct = 'application/x-www-form-urlencoded') => new Request('https://shop.example.co/wp-login.php', { method: 'POST', headers: { 'content-type': ct, 'content-length': String(new TextEncoder().encode(body).length) }, body });

test('readGatedToken reads the form field, the multipart field and the Store API extension', async () => {
	assert.equal(await readGatedToken('login', formReq('log=a&pwd=b&cf-turnstile-response=TOK.1')), 'TOK.1');
	assert.equal(await readGatedToken('login', formReq('log=a&pwd=b')), '');
	const fd = new FormData();
	fd.set('cf-turnstile-response', 'TOK.2');
	const mp = new Request('https://shop.example.co/wp-comments-post.php', { method: 'POST', body: fd });
	const mpBody = await mp.clone().arrayBuffer();
	const mp2 = new Request(mp.url, { method: 'POST', headers: { 'content-type': mp.headers.get('content-type'), 'content-length': String(mpBody.byteLength) }, body: mpBody });
	assert.equal(await readGatedToken('comments', mp2), 'TOK.2');
	const j = JSON.stringify({ billing_address: {}, extensions: { [TURNSTILE_BLOCK_NS]: { token: ' TOK.3 ' } } });
	assert.equal(await readGatedToken('store', formReq(j, 'application/json')), 'TOK.3');
	assert.equal(await readGatedToken('store', formReq(JSON.stringify({ extensions: { other: { token: 'x' } } }), 'application/json')), '');
	assert.equal(await readGatedToken('store', formReq(JSON.stringify({ extensions: { [TURNSTILE_BLOCK_NS]: { token: ['x'] } } }), 'application/json')), '');
	assert.equal(await readGatedToken('store', formReq('not json', 'application/json')), '');
	assert.equal(await readGatedToken('store', formReq('cf-turnstile-response=x')), '', 'a form body on the Store API route');
	assert.equal(await readGatedToken('login', formReq('cf-turnstile-response=x', 'text/plain')), '');
});

test('readGatedToken reads nothing without a length or past the cap, so the gate fails closed', async () => {
	const noLen = new Request('https://shop.example.co/wp-login.php', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'cf-turnstile-response=x' });
	assert.equal(await readGatedToken('login', noLen), '');
	const big = new Request('https://shop.example.co/wp-login.php', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(TURNSTILE_MAX_BODY + 1) }, body: 'cf-turnstile-response=x' });
	assert.equal(await readGatedToken('login', big), '');
});

test('encodeResult and decodeResult round-trip and refuse anything malformed', () => {
	const v = encodeResult({ success: true, codes: [] }, 'TOK');
	assert.deepEqual(decodeResult(v), { success: true, codes: [], tokenHash: tokenHash('TOK') });
	assert.equal(decodeResult(encodeResult({ success: false, codes: [], error: 'timeout' }, 'TOK')).error, 'timeout');
	assert.equal(tokenHash(' TOK '), tokenHash('TOK'));
	assert.match(tokenHash('TOK'), /^[0-9a-f]{64}$/);
	for (const bad of [null, '', 'x', '{}', '{"success":"true","tokenHash":"' + 'a'.repeat(64) + '"}', '{"success":true,"tokenHash":"short"}', '{"success":true}']) {
		assert.equal(decodeResult(bad), null, String(bad));
	}
});

test('the slot answers once, only for the verified token, and fails closed otherwise', () => {
	const slot = new TurnstileSlot();
	assert.deepEqual(slot.take('TOK'), { success: false, codes: ['not-preverified'] });
	slot.set(encodeResult({ success: true, codes: [] }, 'TOK'));
	assert.deepEqual(slot.take('OTHER'), { success: false, codes: ['token-mismatch'] });
	assert.deepEqual(slot.take(''), { success: false, codes: ['missing-input-response'] });
	assert.deepEqual(slot.take('TOK'), { success: true, codes: [] });
	assert.deepEqual(slot.take('TOK'), { success: false, codes: ['already-used'] });
	slot.clear();
	assert.deepEqual(slot.take('TOK'), { success: false, codes: ['not-preverified'] });
	slot.set('garbage');
	assert.deepEqual(slot.take('TOK'), { success: false, codes: ['not-preverified'] });
	// None of these is an outage: no error field, so no fail-open path can let them through.
	for (const r of [slot.take('TOK')]) assert.equal(r.error, undefined);
});

// The chain as index.js runs it: the front Worker (setResultHeader on the forwarded request), then
// the object (takeResultHeader, then the slot for the one PHP run).
async function frontThenObject(clientHeaders, route, token, fetchImpl, slot) {
	const fwd = new Headers(clientHeaders);
	let value = null;
	if (route && token) value = encodeResult(await verifyToken('sec', token, null, { timeoutMs: 1000, fetchImpl }), token);
	setResultHeader(fwd, value);
	const seenByObject = fwd.get(TURNSTILE_RESULT_HEADER);
	slot.set(takeResultHeader(fwd));
	return { seenByObject, phpHeaders: fwd };
}

test('FORGE: a result header sent by the client is never the answer, and PHP never sees the header', async () => {
	const slot = new TurnstileSlot();
	const forged = encodeResult({ success: true, codes: [] }, 'TOK');
	// Not a gated route: the front Worker drops the forged header and sets none.
	let out = await frontThenObject({ [TURNSTILE_RESULT_HEADER]: forged, cookie: 'c=1' }, '', 'TOK', null, slot);
	assert.equal(out.seenByObject, null);
	assert.deepEqual(slot.take('TOK'), { success: false, codes: ['not-preverified'] });
	assert.equal(out.phpHeaders.has(TURNSTILE_RESULT_HEADER), false);
	assert.equal(out.phpHeaders.get('cookie'), 'c=1');
	// A gated route whose real verify fails: the forged success is replaced by the real failure.
	out = await frontThenObject({ [TURNSTILE_RESULT_HEADER]: forged }, 'login', 'TOK', async () => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) }), slot);
	assert.notEqual(out.seenByObject, forged);
	assert.deepEqual(slot.take('TOK'), { success: false, codes: ['invalid-input-response'] });
	assert.equal(out.phpHeaders.has(TURNSTILE_RESULT_HEADER), false);
});

test('a token reused across two requests fails the second time', async () => {
	// Cloudflare spends a token on its first siteverify; a second one is timeout-or-duplicate.
	const spent = new Set();
	const siteverify = async (url, init) => {
		const t = new URLSearchParams(init.body).get('response');
		if (spent.has(t)) return { ok: true, json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] }) };
		spent.add(t);
		return { ok: true, json: async () => ({ success: true }) };
	};
	const slot = new TurnstileSlot();
	await frontThenObject({}, 'login', 'TOK', siteverify, slot);
	assert.equal(slot.take('TOK').success, true);
	slot.clear(); // the end of the first PHP run
	await frontThenObject({}, 'login', 'TOK', siteverify, slot);
	const second = slot.take('TOK');
	assert.equal(second.success, false);
	assert.deepEqual(second.codes, ['timeout-or-duplicate']);
	assert.equal(second.error, undefined, 'a spent token is a failed token, not an outage');
	// The first run's answer does not carry over: with no front verify, the object has nothing.
	slot.clear();
	await frontThenObject({}, '', 'TOK', null, slot);
	assert.deepEqual(slot.take('TOK'), { success: false, codes: ['not-preverified'] });
});

for (const route of ['login', 'woo', 'store']) {
	test(`fail closed on a verifier timeout: ${route}`, async () => {
		const slot = new TurnstileSlot();
		await frontThenObject({}, route, 'TOK', () => new Promise(() => {}), slot);
		const r = slot.take('TOK');
		assert.equal(r.success, false);
		assert.equal(r.error, 'timeout', 'an outage, which PHP shows as unavailable and refuses');
		assert.equal(retryAfterFor(route, r, 503), route === 'store' ? '5' : '');
	});
}

// The two accepted limits (#351): neither gets a front answer, and each is refused as a FAILED
// token (no error field), so PHP answers its normal refusal (a 400 or a notice), never a 500 and
// never the outage path.
for (const [name, method, path] of [
	['a checkout inside a Store API batch request', 'POST', '/wp-json/wc/store/v1/batch'],
	['a checkout inside a Store API batch request (rest_route)', 'POST', '/?rest_route=/wc/store/v1/batch'],
	['a classic checkout posted without wc-ajax (no JavaScript)', 'POST', '/?page_id=7'],
	['a classic checkout posted to the checkout page path', 'POST', '/checkout/'],
]) {
	test(`refused cleanly: ${name}`, async () => {
		assert.equal(turnstileRoute(ON, method, U(path)), '');
		const slot = new TurnstileSlot();
		const out = await frontThenObject({}, turnstileRoute(ON, method, U(path)), 'TOK', async () => { throw new Error('the front Worker must not verify this'); }, slot);
		assert.equal(out.seenByObject, null);
		const r = slot.take('TOK');
		assert.deepEqual(r, { success: false, codes: ['not-preverified'] });
		assert.equal(r.error, undefined, 'a failed token, not an outage: no 503, no fail-open');
	});
}

test('Retry-After only for a Store API outage answered 503', () => {
	assert.equal(retryAfterFor('store', { error: 'timeout' }, 503), '5');
	assert.equal(retryAfterFor('store', { error: 'timeout' }, 400), '');
	assert.equal(retryAfterFor('store', { success: false }, 503), '');
	assert.equal(retryAfterFor('store', null, 503), '');
	assert.equal(retryAfterFor('login', { error: 'timeout' }, 503), '');
});

test('index.js: the object never verifies, and the front Worker sets the answer before the object', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const op = src.slice(src.indexOf('async function turnstileOp('), src.indexOf('// Record one anonymized pageview'));
	const objectBranch = op.slice(op.indexOf("if (ENV.PHP_IN_DO === 'on') {"), op.indexOf('} else {'));
	assert.match(objectBranch, /res = turnstileSlot\.take\(op && op\.token\);/);
	assert.doesNotMatch(objectBranch, /verifyToken|fetch\(|sync\(|setTimeout|await/);
	assert.doesNotMatch(src, /verifyAfterGate|sqlStorage\.sync\(\)/);
	// The front Worker: verify first, then set the header on every forwarded request.
	const front = src.slice(src.indexOf('async function toPhpObject('), src.indexOf('const retried = res.attempts > 1;'));
	assert.ok(front.indexOf('await preverifyTurnstile(req, env, url)') > 0);
	assert.ok(front.indexOf('await preverifyTurnstile(req, env, url)') < front.indexOf('fetchWithMemoryRetry('));
	assert.match(front, /const fwd = new Request\(req\);\s*\/\/[^\n]*\n\s*setResultHeader\(fwd\.headers, pre && pre\.value\);/);
	// The object: take the header off before PHP, set the slot inside the PHP lock, clear it after.
	assert.match(src, /req\.headers\.delete\(SENT_HEADER\);\s*\/\/[^\n]*\n\s*const turnstileHeader = takeResultHeader\(req\.headers\);/);
	// The phpPending-- that ends THIS run: the first one after the slot is set (another holder, such as
	// /_headroom, may decrement it earlier in the file).
	const setAt = src.indexOf('turnstileSlot.set(turnstileHeader);');
	const run = src.slice(setAt, src.indexOf('phpPending--;', setAt));
	assert.ok(run.indexOf('await handle(req, env, url, spikeOk, maxBody, ctx)') > 0);
	assert.match(run, /finally \{\s*turnstileSlot\.clear\(\);/);
});
