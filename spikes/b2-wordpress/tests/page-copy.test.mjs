// node --test spikes/b2-wordpress/tests/page-copy.test.mjs (#1328)
// The leak (#1328 issuecomment-7087244560, forced on cf759hl 3 of 3): when the gateway answers a busy 503 to a request
// for a URL that has a stored guest copy, but the request did NOT go to the cached Pages entrypoint (a WP cookie), the
// edge serves the stored guest copy STALE in its place. A 429 reaches the client as is. So a busy answer for such a
// request is a 429. The scope is the cache's own conditions (page-copy.mjs), never a second copy of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageCopyShape, pageCacheRoute, storeRequestSide, missesStoredCopy, busyAnswerFor, WP_COOKIE } from '../page-copy.mjs';

const ENV = { PAGE_CACHE_TTL: '120' };
const CART = 'woocommerce_items_in_cart=1; woocommerce_cart_hash=x';
const LOGGED = 'wordpress_logged_in_abc=u%7C1';
const mk = (path, { method = 'GET', cookie = null, h = {} } = {}) => {
	const headers = new Headers(h);
	if (cookie) headers.set('cookie', cookie);
	const req = new Request('https://site.example' + path, { method, headers });
	return { req, url: new URL(req.url) };
};
// [label, request, copy can exist (shape), goes to Pages (route), misses a stored copy (the 429 class)]
const TABLE = [
	['guest page GET', mk('/shop/?a=1'), true, true, false],
	['guest HEAD', mk('/shop/', { method: 'HEAD' }), true, true, false],
	['cart-cookie page GET', mk('/shop/', { cookie: CART }), true, false, true],
	['logged-in page GET', mk('/product/x/', { cookie: LOGGED }), true, false, true],
	['analytics cookie only', mk('/shop/', { cookie: '_ga=GA1.1' }), true, true, false],
	['authorization page GET', mk('/shop/', { h: { authorization: 'Basic eDp5' } }), true, false, true],
	['operator page GET', mk('/shop/', { h: { 'x-spike-token': 'anything' } }), true, false, true],
	['upgrade page GET', mk('/shop/', { h: { upgrade: 'websocket' } }), true, false, true],
	['cookie wp-json', mk('/wp-json/wc/store/v1/cart', { cookie: CART }), false, false, false],
	['cookie cart page', mk('/cart/', { cookie: CART }), false, false, false],
	['cookie checkout', mk('/checkout/', { cookie: CART }), false, false, false],
	['cookie my-account', mk('/my-account/', { cookie: LOGGED }), false, false, false],
	['cookie wp-admin', mk('/wp-admin/', { cookie: LOGGED }), false, false, false],
	['cookie wc-ajax', mk('/?wc-ajax=get_refreshed_fragments', { cookie: CART }), false, false, false],
	['cookie rest_route', mk('/?rest_route=/wp/v2/posts', { cookie: LOGGED }), false, false, false],
	['cookie add-to-cart', mk('/shop/?add-to-cart=12', { cookie: CART }), false, false, false],
	['cookie POST', mk('/shop/', { method: 'POST', cookie: CART }), false, false, false],
	['guest POST', mk('/shop/', { method: 'POST' }), false, false, false],
];

test('the shape table: shape, route and the miss class, per request', () => {
	for (const [label, { req, url }, shape, route, miss] of TABLE) {
		assert.equal(pageCopyShape(req, url, ENV), shape, label + ': shape');
		assert.equal(pageCacheRoute(req, url, ENV), route, label + ': route');
		assert.equal(missesStoredCopy(req, url, ENV), miss, label + ': miss');
	}
});
test('PAGE_CACHE_TTL=0: no copy can exist, so nothing is in the miss class', () => {
	const { req, url } = mk('/shop/', { cookie: CART });
	assert.equal(pageCopyShape(req, url, { PAGE_CACHE_TTL: '0' }), false);
	assert.equal(missesStoredCopy(req, url, { PAGE_CACHE_TTL: '0' }), false);
});
test('drift guard: route implies shape, and route and miss never both hold', () => {
	for (const [label, { req, url }] of TABLE) {
		const s = pageCopyShape(req, url, ENV), r = pageCacheRoute(req, url, ENV), m = missesStoredCopy(req, url, ENV);
		assert.ok(!r || s, label + ': route without shape');
		assert.ok(!(r && m), label + ': route and miss');
		assert.equal(m, s && !r, label + ': miss is exactly shape and not route');
	}
});
test('the store decision agrees with the shape (#1371 is the full move): store = shape, minus a WP cookie or authorization', () => {
	for (const [label, { req, url }] of TABLE) {
		const withheld = WP_COOKIE.test(req.headers.get('cookie') || '') || req.headers.has('authorization');
		assert.equal(storeRequestSide(req, url, ENV), pageCopyShape(req, url, ENV) && !withheld, label);
	}
});

const shed = () => new Response('The site is busy. Please try again in a few seconds.\n', { status: 503, headers: { 'retry-after': '5', 'x-overloaded': '1', 'x-php-lock': 'shed', 'cache-control': 'private, no-store' } });
test('busyAnswerFor: a busy 503 for the miss class becomes a 429 with the same body and headers', async () => {
	const { req, url } = mk('/shop/', { cookie: CART });
	const a = busyAnswerFor(req, url, ENV, shed());
	assert.equal(a.status, 429);
	assert.equal(a.headers.get('retry-after'), '5');
	assert.equal(a.headers.get('x-php-lock'), 'shed');
	assert.equal(a.headers.get('x-overloaded'), '1');
	assert.equal(await a.text(), 'The site is busy. Please try again in a few seconds.\n');
});
test('busyAnswerFor: every request in the miss class gets the 429, not only a cookie (authorization, an operator)', () => {
	for (const [label, h] of [['authorization', { authorization: 'Basic eDp5' }], ['operator', { 'x-spike-token': 'anything' }], ['upgrade', { upgrade: 'websocket' }]]) {
		const { req, url } = mk('/shop/', { h });
		assert.equal(busyAnswerFor(req, url, ENV, shed()).status, 429, label);
	}
});
test('busyAnswerFor: everything else is returned untouched (the same object)', () => {
	const guest = mk('/shop/'), rest = mk('/wp-json/x', { cookie: CART }), cookie = mk('/shop/', { cookie: CART });
	for (const [label, r, resp] of [
		['guest shed', guest, shed()],
		['REST shed with a cookie', rest, shed()],
		['a 503 that is not a busy answer (no x-overloaded)', cookie, new Response('x', { status: 503 })],
		['a 500', cookie, new Response('x', { status: 500, headers: { 'x-overloaded': '1' } })],
		['a 200', cookie, new Response('x', { status: 200 })],
	]) {
		assert.equal(busyAnswerFor(r.req, r.url, ENV, resp), resp, label);
	}
});
test('index.js: the gateway fetch passes every answer through busyAnswerFor, and uses the module conditions', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /return operatorNoStore\(scrubPerfHeaders\(busyAnswerFor\(req, new URL\(req\.url\), env, await this\.serve\(req, env, ctx\)\), await perfHeadersAllowed\(req, env\)\), req\);/);
	assert.doesNotMatch(src, /^function pageCacheRoute\(/m, 'pageCacheRoute lives in page-copy.mjs only');
	assert.doesNotMatch(src, /^const (WP_COOKIE|PAGE_CACHE_NO_PATH|PAGE_CACHE_NO_PARAM) =/m, 'the conditions live in page-copy.mjs only');
	const ph = src.slice(src.indexOf('function pageCacheHeaders('), src.indexOf('function pageCacheHeaders(') + 1200);
	assert.match(ph, /storeRequestSide\(req, url, env\) &&/, 'the store decision uses the shared request side');
});
