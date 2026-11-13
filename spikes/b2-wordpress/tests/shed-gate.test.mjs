// Tests of shed-gate.mjs (issue #391): the inbox-wait gate of the PHP object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	SENT_HEADER, ORIGIN_HEADER, stampForObject, inboxWaitMs, shedClass, shedBounds, shouldShed, shedResponse,
	SHED_WAIT_MS_DEFAULT, SHED_WAIT_HARD_MS_DEFAULT,
} from '../shed-gate.mjs';

const U = (p) => new URL(p, 'https://shop.example');
const B = { softMs: 8000, hardMs: 20000 };

test('a client-sent SENT or ORIGIN header is replaced by the Worker, never kept', () => {
	const client = new Request('https://shop.example/?product=a', {
		headers: { [SENT_HEADER]: '1', [ORIGIN_HEADER]: 'https://evil.example', cookie: 'k=v' },
	});
	const fwd = stampForObject(client, 'https://shop.example', 1794555000000);
	assert.equal(fwd.headers.get(SENT_HEADER), '1794555000000');
	assert.equal(fwd.headers.get(ORIGIN_HEADER), 'https://shop.example');
	assert.equal(fwd.headers.get('cookie'), 'k=v', 'other headers pass through');
	// A client that sends an ancient SENT time cannot make its own request look queued.
	assert.equal(inboxWaitMs(fwd.headers.get(SENT_HEADER), 1794555000010), 10);
});

test('the inbox wait: now minus sent', () => {
	assert.equal(inboxWaitMs('1000', 9000), 8000);
	assert.equal(inboxWaitMs(String(5), 5), 0);
});

test('clock skew and bad headers count as 0 (fail open)', () => {
	assert.equal(inboxWaitMs(null, 1000), 0, 'missing');
	assert.equal(inboxWaitMs('', 1000), 0, 'empty');
	assert.equal(inboxWaitMs('abc', 1000), 0, 'not a number');
	assert.equal(inboxWaitMs('0', 200000), 0, 'over 120 s is implausible');
	assert.equal(inboxWaitMs('0', 120001), 0, 'just over 120 s');
	assert.equal(inboxWaitMs('0', 120000), 120000, 'exactly 120 s is plausible');
	assert.equal(inboxWaitMs('10000', 4000), 0, 'under -5 s is implausible');
	assert.equal(inboxWaitMs('1000', 500), 0, 'a small negative skew is 0');
	const bounds = shedBounds({});
	assert.equal(shouldShed(inboxWaitMs('0', 10 ** 13), 'soft', U('/'), bounds), false, 'an implausible wait never sheds');
});

test('page reads are soft; writes and a shopper’s own pages are hard', () => {
	assert.equal(shedClass('GET', U('/?product=edge-mug')), 'soft');
	assert.equal(shedClass('HEAD', U('/shop/')), 'soft');
	assert.equal(shedClass('GET', U('/wp-json/oembed/1.0/embed?url=x')), 'soft');
	for (const p of ['/cart/', '/checkout/', '/checkout/order-received/5/', '/my-account/', '/wp-admin/', '/wp-login.php', '/wc-api/x', '/wp-json/wc/store/v1/cart']) {
		assert.equal(shedClass('GET', U(p)), 'hard', p);
	}
	for (const q of ['/?wc-ajax=update_order_review', '/?add-to-cart=12', '/?rest_route=/wc/store/v1/cart']) assert.equal(shedClass('GET', U(q)), 'hard', q);
	for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal(shedClass(m, U('/?product=a')), 'hard', m);
	assert.equal(shedClass('GET', U('/cartography/')), 'soft', 'a prefix is not a match');
});

test('soft sheds past softMs, hard only past hardMs', () => {
	assert.equal(shouldShed(8000, 'soft', U('/'), B), false);
	assert.equal(shouldShed(8001, 'soft', U('/'), B), true);
	assert.equal(shouldShed(8001, 'hard', U('/checkout/'), B), false, 'a write still gets in while reads are shed');
	assert.equal(shouldShed(20001, 'hard', U('/checkout/'), B), true);
});

test('spike paths are never shed', () => {
	assert.equal(shouldShed(10 ** 6, 'soft', U('/_install'), B), false);
	assert.equal(shouldShed(10 ** 6, 'hard', U('/_dbimport'), B), false);
});

test('bounds: defaults, overrides, off, and bad values fall back', () => {
	assert.deepEqual(shedBounds({}), { softMs: SHED_WAIT_MS_DEFAULT, hardMs: SHED_WAIT_HARD_MS_DEFAULT });
	assert.deepEqual(shedBounds({ SHED_WAIT_MS: '3000', SHED_WAIT_HARD_MS: '15000' }), { softMs: 3000, hardMs: 15000 });
	assert.equal(shedBounds({ SHED_WAIT_MS: 'off' }).softMs, Infinity);
	assert.equal(shouldShed(10 ** 5, 'soft', U('/'), shedBounds({ SHED_WAIT_MS: 'off', SHED_WAIT_HARD_MS: 'off' })), false);
	assert.equal(shedBounds({ SHED_WAIT_MS: '-1' }).softMs, SHED_WAIT_MS_DEFAULT);
	assert.equal(shedBounds({ SHED_WAIT_MS: 'abc' }).softMs, SHED_WAIT_MS_DEFAULT);
	assert.ok(SHED_WAIT_MS_DEFAULT < SHED_WAIT_HARD_MS_DEFAULT, 'reads are shed before writes');
});

test('the shed answer: a 503 with a retry hint that no cache keeps', async () => {
	const r = shedResponse(9123.4, 'soft', 'php-0');
	assert.equal(r.status, 503);
	assert.equal(r.headers.get('retry-after'), '5');
	assert.equal(r.headers.get('cache-control'), 'no-store');
	assert.equal(r.headers.get('cloudflare-cdn-cache-control'), 'no-store');
	assert.equal(r.headers.get('x-shed'), 'soft');
	assert.equal(r.headers.get('x-shed-wait-ms'), '9123');
	assert.match(await r.text(), /busy/);
});

test('index.js: the Worker stamps the object request through stampForObject only', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.ok(!/fwd\.headers\.set\(SENT_HEADER/.test(src), 'no hand-set SENT header');
	assert.match(src, /stub\.fetch\(stampForObject\(req, /);
});

test('perf-headers.mjs scrubs the wait header for a visitor', async () => {
	const { PERF_HEADERS } = await import('../perf-headers.mjs');
	assert.ok(PERF_HEADERS.includes('x-shed-wait-ms'));
});
