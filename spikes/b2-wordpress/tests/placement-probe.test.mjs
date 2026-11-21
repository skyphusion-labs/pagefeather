// node --test spikes/b2-wordpress/tests/placement-probe.test.mjs (#1277)
// The option-1 probe: does a page-cache MISS render handed from Pages (a named entrypoint, which Smart Placement
// does not place) to the gateway's fetch handler through ctx.exports.default.fetch run at the placed colo?
// Rule set before the data: #1277 issuecomment-7064641735. Off unless PLACEMENT_PROBE_KEY (16+ characters) is set;
// a request without the right key behaves exactly as today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { probeArm, coloFromTrace, traceColo, renderRequest, PROBE_HEADER } from '../placement-probe.mjs';

const KEY = 'k'.repeat(24);
const req = (v) => new Request('https://x.example/product/a/?pfprobe=1', { headers: v === undefined ? {} : { [PROBE_HEADER]: v } });

test('#1277 off by default: no key, a short key, no header, a wrong key, an unknown arm', () => {
	assert.equal(probeArm(req('loop:' + KEY), {}), null, 'no PLACEMENT_PROBE_KEY');
	assert.equal(probeArm(req('loop:short'), { PLACEMENT_PROBE_KEY: 'short' }), null, 'a key under 16 characters is off');
	assert.equal(probeArm(req(), { PLACEMENT_PROBE_KEY: KEY }), null, 'no header');
	assert.equal(probeArm(req('loop:' + 'x'.repeat(24)), { PLACEMENT_PROBE_KEY: KEY }), null, 'wrong key');
	assert.equal(probeArm(req('loop:' + KEY + 'x'), { PLACEMENT_PROBE_KEY: KEY }), null, 'a longer key');
	assert.equal(probeArm(req('nope:' + KEY), { PLACEMENT_PROBE_KEY: KEY }), null, 'unknown arm');
	assert.equal(probeArm(req('loop'), { PLACEMENT_PROBE_KEY: KEY }), null, 'no key part');
});
test('#1277 the four arms with the right key', () => {
	for (const a of ['pages', 'loop', 'direct', 'render']) assert.equal(probeArm(req(a + ':' + KEY), { PLACEMENT_PROBE_KEY: KEY }), a);
});
test('#1277 the colo comes from cdn-cgi/trace inside the running code', async () => {
	assert.equal(coloFromTrace('fl=1\nh=www.cloudflare.com\ncolo=SEA\nhttp=http/1.1\n'), 'SEA');
	assert.equal(coloFromTrace('nothing here'), null);
	let asked = null;
	assert.equal(await traceColo(async (u) => { asked = String(u); return new Response('colo=DFW\n'); }), 'DFW');
	assert.match(asked, /\/cdn-cgi\/trace$/);
	assert.match(await traceColo(async () => { throw new Error('down'); }), /^error:/, 'a failed trace is said, never a colo');
	assert.match(await traceColo(async () => new Response('no colo')), /^error:/);
	assert.match(await traceColo(() => new Promise(() => {}), 20), /^error:/, 'a hung trace times out');
});
test('#1277 renderRequest: the same URL and headers, the arm set to render', () => {
	const r0 = new Request('https://x.example/product/a/?pfprobe=7', { headers: { [PROBE_HEADER]: 'loop:' + KEY, 'x-perf-id': 'p1' } });
	const r = renderRequest(r0, KEY);
	assert.equal(r.url, r0.url);
	assert.equal(r.headers.get('x-perf-id'), 'p1');
	assert.equal(probeArm(r, { PLACEMENT_PROBE_KEY: KEY }), 'render');
});
test('#1277 index.js wires it: gateway renders direct/render arms before the page cache; Pages runs pages/loop', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const gw = src.slice(src.indexOf('export default {'));
	assert.ok(gw.indexOf('probeArm(req, env)') > 0 && gw.indexOf('probeArm(req, env)') < gw.indexOf('if (pageCacheRoute(req, url, env)) {'), 'the gateway checks the probe before the page cache');
	const route = src.slice(src.indexOf('function pageCacheRoute(req, url, env) {'), src.indexOf('function pageCacheHeaders('));
	assert.match(route, /!\['direct', 'render'\]\.includes\(probeArm\(req, env\)\)/, 'direct and render never go to the page cache');
	assert.match(gw, /if \(probeColo\) \{[\s\S]{0,200}noStoreAnywhere\(pout\.headers\)/, 'a gateway probe answer is never stored');
	const pages = src.slice(src.indexOf('export class Pages extends WorkerEntrypoint {'), src.indexOf('export default {'));
	assert.match(pages, /probeArm\(req, this\.env\)/);
	assert.match(pages, /probe !== 'loop' \? await site\.fetch\(req, this\.env, this\.ctx\) : await this\.ctx\.exports\.default\.fetch\(renderRequest\(req, this\.env\.PLACEMENT_PROBE_KEY\)\)/);
	assert.equal((src.match(/x-pf-probe-colo-(pages|render)/g) || []).length >= 2, true);
	assert.ok((pages.match(/noStoreAnywhere\(/g) || []).length >= 2, 'a probe answer from Pages is never stored');
});
