// node --test spikes/b2-wordpress/tests/pages-render.test.mjs (#1277 option 1)
// Smart Placement places fetch handlers, not named entrypoints, so on approach A a page-cache MISS rendered in Pages
// ran PHP at the ingress colo, about 105 ms per query from DFW and LAX against about 18 placed (#1277
// issuecomment-7064621362). Option 1: on approach A (PHP runs in the Worker), Pages hands the MISS render to the
// gateway's placed fetch handler (ctx.exports.default.fetch) and caches its answer. The probe showed the loopback runs
// placed (SEA, 1.01x direct). On b-dosql and b-do, Pages already forwards to the object: unchanged. It merges only on
// the loaded repeat's rule (#1277 issuecomment-7069856462).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGES_RENDER_HEADER, placedRenderRequest, isPlacedRender, rendersInWorker } from '../pages-render.mjs';

test('#1277 rendersInWorker: approach A only (PHP and the database outside an object)', () => {
	assert.equal(rendersInWorker({}), true, 'approach A');
	assert.equal(rendersInWorker({ DB_IN_DO: 'on' }), false, 'b-dosql: Pages already forwards to the object');
	assert.equal(rendersInWorker({ PHP_IN_DO: 'on' }), false, 'b-do');
	assert.equal(rendersInWorker(null), false);
});
test('#1277 placedRenderRequest marks the request and keeps the URL, method and headers', () => {
	const r0 = new Request('https://x.example/product/a/?pcv=3', { headers: { accept: 'text/html', 'x-perf-id': 'p1' } });
	assert.equal(isPlacedRender(r0), false);
	const r = placedRenderRequest(r0);
	assert.equal(r.url, r0.url);
	assert.equal(r.method, 'GET');
	assert.equal(r.headers.get('accept'), 'text/html');
	assert.equal(r.headers.get('x-perf-id'), 'p1');
	assert.equal(r.headers.get(PAGES_RENDER_HEADER), '1');
	assert.equal(isPlacedRender(r), true);
});
test('#1277 index.js wires it: Pages hands an approach A MISS to the gateway, which renders it and never sends it back to Pages', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const pages = src.slice(src.indexOf('export class Pages extends WorkerEntrypoint {'), src.indexOf('export default {'));
	assert.match(pages, /const r = rendersInWorker\(this\.env\) \? await this\.ctx\.exports\.default\.fetch\(placedRenderRequest\(req\)\) : await site\.fetch\(req, this\.env, this\.ctx\);/);
	// #1328: pageCacheRoute lives in page-copy.mjs.
	const route = readFileSync(new URL('../page-copy.mjs', import.meta.url), 'utf8').replace(/^[\s\S]*?export function pageCacheRoute\(/, 'function pageCacheRoute(').replace(/export function storeRequestSide[\s\S]*$/, '');
	assert.match(route, /!isPlacedRender\(req\)/, 'a marked request never loops back to Pages');
	const only = pages.indexOf("if (req.headers.get(SELF_CACHE_ONLY_HEADER) === '1') return selfCacheMissResponse();");
	assert.ok(only > 0 && only < pages.indexOf('rendersInWorker(this.env)'), "the #1170 cache-only answer still comes first");
});

// #1328: since #1296 the gateway's answer to Pages' placed render carried the storable cloudflare-cdn-cache-control.
// The gateway (the default entrypoint) had never answered with one before: a cache layer consumes the directive it
// obeys, and before #1296 Pages' cache consumed it, so nothing storable left the default entrypoint. A copy of that
// cookieless answer then reached shoppers with cart cookies (cf759hl, hlm029: /classic-cart/ HIT with no x-entrypoint
// and no x-pf-rendered), and Pages' own copy arrived with only cache-control: no-cache (stored stale: every guest GET
// MISS or EXPIRED on cf759hl, 2026-11-22). Rule: the default entrypoint's answer is never storable. The directive
// travels to Pages in private headers, and Pages, the one cached entrypoint, restores it.
const prMod = await import('../pages-render.mjs');
test('#1328 sealPlacedCache: the placed answer is no-store, and the directive travels privately', () => {
	assert.equal(typeof prMod.sealPlacedCache, 'function');
	const h = new Headers({ 'cache-tag': 'stale' });
	prMod.sealPlacedCache(h, 'max-age=120, stale-while-revalidate=30', 'wp-pages');
	assert.equal(h.get('cloudflare-cdn-cache-control'), 'no-store', 'nothing in front of the gateway may store it');
	assert.equal(h.get('cache-tag'), null, 'no purge tag on an answer nothing stores');
	assert.equal(h.get(prMod.PLACED_CDN_CC_HEADER), 'max-age=120, stale-while-revalidate=30');
	assert.equal(h.get(prMod.PLACED_CACHE_TAG_HEADER), 'wp-pages');
});
test('#1328 unsealPlacedCache: Pages restores the directive and the tag, and the private headers never leave', () => {
	const h = new Headers({ 'cloudflare-cdn-cache-control': 'no-store' });
	prMod.sealPlacedCache(h, 'max-age=120', 'wp-pages');
	assert.equal(prMod.unsealPlacedCache(h), true);
	assert.equal(h.get('cloudflare-cdn-cache-control'), 'max-age=120');
	assert.equal(h.get('cache-tag'), 'wp-pages');
	assert.equal(h.get(prMod.PLACED_CDN_CC_HEADER), null);
	assert.equal(h.get(prMod.PLACED_CACHE_TAG_HEADER), null);
	// not cacheable (a cookie, a no-cache answer): the gateway sent no-store and nothing to restore
	const n = new Headers({ 'cloudflare-cdn-cache-control': 'no-store', 'cache-control': 'private, no-store' });
	assert.equal(prMod.unsealPlacedCache(n), false);
	assert.equal(n.get('cloudflare-cdn-cache-control'), 'no-store', 'stays no-store');
	assert.equal(n.get('cache-tag'), null);
});
test('#1328 index.js: on a placed render pageCacheHeaders seals; the gateway never sets a storable directive itself', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const f = src.slice(src.indexOf('function pageCacheHeaders('), src.indexOf('// One R2 operation for the R2 Uploads mu-plugin'));
	assert.ok(f.length > 0);
	assert.match(f, /if \(isPlacedRender\(req\)\) sealPlacedCache\(out, cdn, 'wp-pages'\);/, 'a placed render is sealed');
	const sets = f.split('\n').filter((l) => /out\.set\('cloudflare-cdn-cache-control', (?!'no-store')/.test(l));
	assert.equal(sets.length, 1, 'one storable set');
	assert.match(sets[0], /else \{ out\.set\('cloudflare-cdn-cache-control', cdn\);/, 'only on the else of the placed check');
	const pages = src.slice(src.indexOf('export class Pages extends WorkerEntrypoint {'), src.indexOf('export default {'));
	const un = pages.indexOf('unsealPlacedCache(out.headers);');
	assert.ok(un > 0, 'Pages restores it');
	assert.ok(un > pages.indexOf('const out = new Response(r.body, r);'), 'on the answer Pages returns');
	assert.ok(un < pages.indexOf('if (isOperatorRequest(req)) noStoreAnywhere(out.headers);'), 'before the operator no-store, which must win');
});
test('#1328 a request with cart or session cookies is never sent to the cached entrypoint (pageCacheRoute and WP_COOKIE)', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const m = /const WP_COOKIE = (\/.*\/);\n/.exec(src);
	assert.ok(m, 'WP_COOKIE');
	const re = eval(m[1]);
	for (const c of ['woocommerce_cart_hash=abc', 'woocommerce_items_in_cart=1', 'wp_woocommerce_session_0123=x', 'wordpress_logged_in_abc=x', 'other=1; woocommerce_cart_hash=abc']) assert.ok(re.test(c), c);
	assert.equal(re.test('foo=bar'), false, 'a non-WordPress cookie does not split the cache');
	const route = src.slice(src.indexOf('function pageCacheRoute(req, url, env) {'), src.indexOf('function pageCacheHeaders('));
	assert.match(route, /!WP_COOKIE\.test\(req\.headers\.get\('cookie'\) \|\| ''\)/);
});
