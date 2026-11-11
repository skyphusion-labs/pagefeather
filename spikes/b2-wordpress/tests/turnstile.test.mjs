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
} from '../turnstile.mjs';

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
