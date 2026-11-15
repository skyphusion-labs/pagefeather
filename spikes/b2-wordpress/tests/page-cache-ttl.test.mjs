// C2 of #628: a shorter edge TTL for WooCommerce product pages only, behind PAGE_CACHE_PRODUCT_TTL.
// Unset, the edge rule is byte for byte today's: max-age=PAGE_CACHE_TTL, stale-while-revalidate=600.
// Set, a product, shop or product-category page (marked by edge-cache.php with x-pf-page: product)
// gets max-age=<it> AND stale-while-revalidate=<it>: cut to match, or the first visitor after a
// quiet spell could still get a copy 600 s old. The mark never leaves the Worker.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PRODUCT_PAGE_HEADER, productTtl, isProductPage, edgeCacheControl } from '../page-cache-ttl.mjs';

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
