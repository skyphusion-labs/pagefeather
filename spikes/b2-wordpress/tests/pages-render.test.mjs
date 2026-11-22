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
