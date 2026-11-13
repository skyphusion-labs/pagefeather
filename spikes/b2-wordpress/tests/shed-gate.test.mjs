// Tests of shed-gate.mjs (issue #391): the in-object gate of the PHP object.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	SENT_HEADER, ORIGIN_HEADER, stampForObject, inboxWaitMs, shedClass, shedBounds, shouldShed, shedResponse, gated, inObjectCount,
	SHED_SOFT_DEFAULT, SHED_HARD_DEFAULT,
} from '../shed-gate.mjs';

const U = (p) => new URL(p, 'https://shop.example');
const B = { soft: 4, hard: 1 };
const req = (path, method = 'GET', headers = {}) => new Request('https://shop.example' + path, { method, headers });

test('a client-sent SENT or ORIGIN header is replaced by the Worker, never kept', () => {
	const client = new Request('https://shop.example/?product=a', {
		headers: { [SENT_HEADER]: '1', [ORIGIN_HEADER]: 'https://evil.example', cookie: 'k=v' },
	});
	const fwd = stampForObject(client, 'https://shop.example', 1794555000000);
	assert.equal(fwd.headers.get(SENT_HEADER), '1794555000000');
	assert.equal(fwd.headers.get(ORIGIN_HEADER), 'https://shop.example');
	assert.equal(fwd.headers.get('cookie'), 'k=v', 'other headers pass through');
});

test('the inbox wait: now minus sent; skew and bad headers count as 0 (fail open)', () => {
	assert.equal(inboxWaitMs('1000', 9000), 8000);
	assert.equal(inboxWaitMs(null, 1000), 0, 'missing');
	assert.equal(inboxWaitMs('', 1000), 0, 'empty');
	assert.equal(inboxWaitMs('abc', 1000), 0, 'not a number');
	assert.equal(inboxWaitMs('0', 120001), 0, 'over 120 s is implausible');
	assert.equal(inboxWaitMs('0', 120000), 120000, 'exactly 120 s is plausible');
	assert.equal(inboxWaitMs('10000', 4000), 0, 'under -5 s is implausible');
	assert.equal(inboxWaitMs('1000', 500), 0, 'a small negative skew is 0');
});

test('the gate never reads the client clock: a forged ancient SENT header does not shed', async () => {
	const r = await gated(req('/?product=a', 'GET', { [SENT_HEADER]: '1' }), {}, U('/?product=a'), 'php-0', async () => new Response('ok'));
	assert.equal(r.status, 200);
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

test('soft sheds at soft in the object; a write waits outside while anything is in it', () => {
	assert.equal(shouldShed(3, 'soft', U('/'), B), false);
	assert.equal(shouldShed(4, 'soft', U('/'), B), true);
	assert.equal(shouldShed(0, 'hard', U('/checkout/'), B), false, 'a write enters an empty object');
	assert.equal(shouldShed(1, 'hard', U('/checkout/'), B), true, 'a write never enters while a render is in flight');
});

test('spike paths are never shed', () => {
	assert.equal(shouldShed(10 ** 6, 'soft', U('/_install'), B), false);
	assert.equal(shouldShed(10 ** 6, 'hard', U('/_dbimport'), B), false);
});

test('bounds: defaults, overrides, off, and bad values fall back', () => {
	assert.deepEqual(shedBounds({}), { soft: SHED_SOFT_DEFAULT, hard: SHED_HARD_DEFAULT });
	assert.deepEqual(shedBounds({ SHED_SOFT: '3', SHED_HARD: '9' }), { soft: 3, hard: 9 });
	assert.equal(shedBounds({ SHED_SOFT: 'off' }).soft, Infinity);
	assert.equal(shouldShed(10 ** 5, 'soft', U('/'), shedBounds({ SHED_SOFT: 'off', SHED_HARD: 'off' })), false);
	for (const bad of ['-1', '0', 'abc', '2.5']) assert.equal(shedBounds({ SHED_SOFT: bad }).soft, SHED_SOFT_DEFAULT, bad);
	assert.equal(SHED_HARD_DEFAULT, 1, 'a write waits for an empty object (the probe result)');
	assert.ok(SHED_SOFT_DEFAULT >= 1, 'reads are bounded');
});

test('the shed answer: a 503 with a retry hint that no cache keeps', async () => {
	assert.equal(shedResponse(0, 'hard', 'php-0', 1).headers.get('retry-after'), '1', 'a write is told to retry soon');
	const r = shedResponse(9123.4, 'soft', 'php-0', 4);
	assert.equal(r.status, 503);
	assert.equal(r.headers.get('retry-after'), '5');
	assert.equal(r.headers.get('cache-control'), 'no-store');
	assert.equal(r.headers.get('cloudflare-cdn-cache-control'), 'no-store');
	assert.equal(r.headers.get('x-shed'), 'soft');
	assert.equal(r.headers.get('x-shed-wait-ms'), '9123');
	assert.equal(r.headers.get('x-shed-in-object'), '4');
	assert.match(await r.text(), /busy/);
});

test('gated: a burst of reads is cut at soft; a write waits outside until the object is empty', async () => {
	const env = { SHED_SOFT: '3', SHED_HARD: '1' };
	const held = [];
	const serve = () => new Promise((ok) => held.push(() => ok(new Response('rendered'))));
	const reads = Array.from({ length: 6 }, (_, i) => gated(req('/?product=' + i), env, U('/?product=' + i), 'php-0', serve));
	await new Promise((ok) => setTimeout(ok, 0));
	assert.equal(inObjectCount(), 3, 'only soft reads are admitted');
	const busy = await gated(req('/?rest_route=/wc/store/v1/cart/add-item', 'POST'), env, U('/?rest_route=/wc/store/v1/cart/add-item'), 'php-0', serve);
	assert.equal(busy.status, 503, 'a write is shed while renders are in flight');
	assert.equal(busy.headers.get('retry-after'), '1');
	const shedReads = await Promise.race([Promise.all(reads.slice(3)), new Promise((ok) => setTimeout(() => ok(null), 50))]);
	assert.ok(shedReads, 'the shed reads answer at once, not after the admitted ones');
	assert.deepEqual(shedReads.map((r) => r.status), [503, 503, 503]);
	for (const go of held.splice(0)) go();
	assert.deepEqual((await Promise.all(reads.slice(0, 3))).map((r) => r.status), [200, 200, 200]);
	assert.equal(inObjectCount(), 0);
	const write = gated(req('/?rest_route=/wc/store/v1/cart/add-item', 'POST'), env, U('/?rest_route=/wc/store/v1/cart/add-item'), 'php-0', serve);
	await new Promise((ok) => setTimeout(ok, 0));
	assert.equal(inObjectCount(), 1, 'the retried write enters the empty object');
	for (const go of held.splice(0)) go();
	assert.equal((await write).status, 200);
	assert.equal(inObjectCount(), 0);
});

test('gated: a serve that throws still frees its slot', async () => {
	await assert.rejects(gated(req('/'), {}, U('/'), 'php-0', async () => { throw new Error('boom'); }));
	assert.equal(inObjectCount(), 0);
});

test('index.js: the gate wraps the whole object fetch, before any storage I/O', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const a = src.indexOf('\tasync fetch(raw) {');
	const body = src.slice(a, src.indexOf('\tasync serveObject(raw, objectUrl) {'));
	assert.ok(a > 0 && body.length > 0);
	assert.match(body, /return gated\(raw, this\.env, objectUrl, /);
	assert.ok(!/storage\.|await rearm/.test(body), 'no storage call before the gate');
});

test('index.js: withPhp yields one event-loop turn before each render', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const w = src.slice(src.indexOf('function withPhp(fn) {'), src.indexOf('phpQueue = run.catch'));
	assert.match(w, /await new Promise\(\(ok\) => setTimeout\(ok, 0\)\);\s*return fn\(\);/);
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
