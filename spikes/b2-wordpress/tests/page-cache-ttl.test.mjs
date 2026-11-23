// C2 of #628: a shorter edge TTL for WooCommerce product pages only, behind PAGE_CACHE_PRODUCT_TTL.
// Unset, the edge rule is byte for byte today's: max-age=PAGE_CACHE_TTL, stale-while-revalidate=600.
// Set, a product, shop or product-category page (marked by edge-cache.php with x-pf-page: product)
// gets max-age=<it> AND stale-while-revalidate=<it>: cut to match, or the first visitor after a
// quiet spell could still get a copy 600 s old. The mark never leaves the Worker.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isPlacedRender, sealPlacedCache, placedRenderRequest, PLACED_CDN_CC_HEADER } from '../pages-render.mjs';
import { PRODUCT_PAGE_HEADER, productTtl, isProductPage, edgeCacheControl } from '../page-cache-ttl.mjs';
import { storeRequestSide } from '../page-copy.mjs';

test('the flag: unset or bad is off (null); an integer from 5 to 600 is on', () => {
	assert.equal(productTtl({}), null);
	assert.equal(productTtl({ PAGE_CACHE_PRODUCT_TTL: '' }), null);
	for (const bad of ['0', '4', '601', '-5', 'abc', '30s', '1e2', ' 30']) assert.equal(productTtl({ PAGE_CACHE_PRODUCT_TTL: bad }), null, bad);
	assert.equal(productTtl({ PAGE_CACHE_PRODUCT_TTL: '30' }), 30);
	assert.equal(productTtl({ PAGE_CACHE_PRODUCT_TTL: '5' }), 5);
	assert.equal(productTtl({ PAGE_CACHE_PRODUCT_TTL: '600' }), 600);
});

test('a product page is the one PHP marked, as a string or a list', () => {
	assert.equal(PRODUCT_PAGE_HEADER, 'x-pf-page');
	assert.equal(isProductPage({ 'x-pf-page': 'product' }), true);
	assert.equal(isProductPage({ 'x-pf-page': ['product'] }), true);
	assert.equal(isProductPage({ 'x-pf-page': 'post' }), false);
	assert.equal(isProductPage({}), false);
	assert.equal(isProductPage(undefined), false);
});

test('flag off: every page keeps today rule, product pages too', () => {
	assert.equal(edgeCacheControl(120, null, true), 'max-age=120, stale-while-revalidate=600');
	assert.equal(edgeCacheControl(120, null, false), 'max-age=120, stale-while-revalidate=600');
	assert.equal(edgeCacheControl(300, null, true), 'max-age=300, stale-while-revalidate=600');
});

test('flag on: a product page gets the short TTL and the same stale window; other pages do not change', () => {
	assert.equal(edgeCacheControl(120, 30, true), 'max-age=30, stale-while-revalidate=30');
	assert.equal(edgeCacheControl(120, 30, false), 'max-age=120, stale-while-revalidate=600');
});

test('flag on: the short TTL never makes a product page LONGER lived than the site TTL', () => {
	assert.equal(edgeCacheControl(20, 30, true), 'max-age=20, stale-while-revalidate=20');
});

test('index.js uses it in pageCacheHeaders, and always removes the mark from the answer', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{ PRODUCT_PAGE_HEADER, productTtl, isProductPage, edgeCacheControl \} from '\.\/page-cache-ttl\.mjs';/);
	const fn = src.slice(src.indexOf('function pageCacheHeaders('), src.indexOf('\n}\n', src.indexOf('function pageCacheHeaders(')));
	assert.match(fn, /edgeCacheControl\(ttl, productTtl\(env\), isProductPage\(r\.headers\)\)/);
	assert.ok(!/stale-while-revalidate=600/.test(fn), 'the old literal rule is gone from pageCacheHeaders');
	// The removal sits before the cacheable branch, so a page that is NOT cached loses the mark too.
	const del = fn.indexOf('out.delete(PRODUCT_PAGE_HEADER)');
	assert.ok(del > 0 && del < fn.indexOf('if (cacheable)'), 'the mark is removed on every answer');
});

test('#766: an answer made while any SQL statement failed is never stored at the edge (pageCacheHeaders, run)', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const start = src.indexOf('function pageCacheHeaders(');
	const fn = src.slice(start, src.indexOf('\n}\n', start) + 2);
	// #1328: the request conditions live in page-copy.mjs; the real storeRequestSide is passed in.
	const pageCacheHeaders = new Function('PRODUCT_PAGE_HEADER', 'productTtl', 'isProductPage', 'edgeCacheControl', 'storeRequestSide', 'isPlacedRender', 'sealPlacedCache',
		fn + '\nreturn pageCacheHeaders;')(PRODUCT_PAGE_HEADER, productTtl, isProductPage, edgeCacheControl, storeRequestSide, isPlacedRender, sealPlacedCache);
	const run = (failed) => {
		const out = new Headers();
		const req = new Request('https://shop.example/?product=mug');
		pageCacheHeaders(req, new URL(req.url), { httpStatusCode: 200, headers: {} }, out, {}, failed);
		return out.get('cloudflare-cdn-cache-control');
	};
	assert.match(run(0), /^max-age=120, /, 'control: a guest 200 with no failed statement is stored');
	assert.equal(run(1), 'no-store', 'one failed statement: not stored');
	assert.equal(run(3), 'no-store');
	assert.match(src, /pageCacheHeaders\(req, url, r, out, env, d\.failures\.length\);/, 'index.js passes the request failures');
});

test('#1328: a placed guest render through pageCacheHeaders leaves the gateway no-store, its directive private', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const start = src.indexOf('function pageCacheHeaders(');
	const fn = src.slice(start, src.indexOf('\n}\n', start) + 2);
	// #1328: the request conditions live in page-copy.mjs; the real storeRequestSide is passed in.
	const pageCacheHeaders = new Function('PRODUCT_PAGE_HEADER', 'productTtl', 'isProductPage', 'edgeCacheControl', 'storeRequestSide', 'isPlacedRender', 'sealPlacedCache',
		fn + '\nreturn pageCacheHeaders;')(PRODUCT_PAGE_HEADER, productTtl, isProductPage, edgeCacheControl, storeRequestSide, isPlacedRender, sealPlacedCache);
	const run = (req) => {
		const out = new Headers();
		pageCacheHeaders(req, new URL(req.url), { httpStatusCode: 200, headers: {} }, out, {}, 0);
		return out;
	};
	const direct = run(new Request('https://shop.example/classic-cart/'));
	assert.match(direct.get('cloudflare-cdn-cache-control'), /^max-age=120, /, 'control: a guest render in Pages (b-dosql) is stored, as before');
	assert.equal(direct.get('cache-tag'), 'wp-pages');
	const placed = run(placedRenderRequest(new Request('https://shop.example/classic-cart/')));
	assert.equal(placed.get('cloudflare-cdn-cache-control'), 'no-store', 'the gateway answer is never storable');
	assert.equal(placed.get('cache-tag'), null);
	assert.match(placed.get(PLACED_CDN_CC_HEADER), /^max-age=120, /, 'the directive travels to Pages');
	const cart = run(placedRenderRequest(new Request('https://shop.example/classic-cart/', { headers: { cookie: 'woocommerce_items_in_cart=1; wp_woocommerce_session_a=b' } })));
	assert.equal(cart.get('cloudflare-cdn-cache-control'), 'no-store', 'with cart cookies: never stored');
	assert.equal(cart.get(PLACED_CDN_CC_HEADER), null, 'and nothing for Pages to restore');
});

test('#759: a WordPress no-cache private answer gets no-store on the browser header', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const start = src.indexOf('function pageCacheHeaders(');
	const fn = src.slice(start, src.indexOf('\n}\n', start) + 2);
	// #1328: the request conditions live in page-copy.mjs; the real storeRequestSide is passed in.
	const pageCacheHeaders = new Function('PRODUCT_PAGE_HEADER', 'productTtl', 'isProductPage', 'edgeCacheControl', 'storeRequestSide', 'isPlacedRender', 'sealPlacedCache',
		fn + '\nreturn pageCacheHeaders;')(PRODUCT_PAGE_HEADER, productTtl, isProductPage, edgeCacheControl, storeRequestSide, isPlacedRender, sealPlacedCache);
	const wpCc = 'no-cache, must-revalidate, max-age=0, private';
	const out = new Headers({ 'cache-control': wpCc });
	const req = new Request('https://shop.example/wp-admin/', { headers: { cookie: 'wordpress_logged_in=1' } });
	pageCacheHeaders(req, new URL(req.url), { httpStatusCode: 200, headers: { 'cache-control': wpCc } }, out, {}, 0);
	assert.match(out.get('cache-control') || '', /no-store/);
	assert.match(out.get('cache-control') || '', /no-cache/);
	assert.match(out.get('cache-control') || '', /private/);
});
