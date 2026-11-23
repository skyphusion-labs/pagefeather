// node --test spikes/b2-wordpress/tests/placement-probe.test.mjs (#1277)
// The option-1 probe: does a page-cache MISS render handed from Pages (a named entrypoint, which Smart Placement
// does not place) to the gateway's fetch handler through ctx.exports.default.fetch run at the placed colo?
// Rule set before the data: #1277 issuecomment-7064641735. Off unless PLACEMENT_PROBE_KEY (16+ characters) is set;
// a request without the right key behaves exactly as today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { probeArm, coloFromTrace, traceColo, renderRequest, probeObjectName, PROBE_HEADER, PROBE_TRACED_HEADER } from '../placement-probe.mjs';

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
	const route = readFileSync(new URL('../page-copy.mjs', import.meta.url), 'utf8').replace(/^[\s\S]*?export function pageCacheRoute\(/, 'function pageCacheRoute(').replace(/export function storeRequestSide[\s\S]*$/, '');
	assert.match(route, /!\['direct', 'render', 'object', 'object-new'\]\.includes\(probeArm\(req, env\)\)/, 'direct, render and the object arms never go to the page cache');
	assert.match(gw, /if \(probeColo\) \{[\s\S]{0,200}noStoreAnywhere\(pout\.headers\)/, 'a gateway probe answer is never stored');
	const pages = src.slice(src.indexOf('export class Pages extends WorkerEntrypoint {'), src.indexOf('export default {'));
	assert.match(pages, /probeArm\(req, this\.env\)/);
	assert.match(pages, /probe !== 'loop' \? await site\.fetch\(req, this\.env, this\.ctx\) : await this\.ctx\.exports\.default\.fetch\(renderRequest\(req, this\.env\.PLACEMENT_PROBE_KEY\)\)/);
	assert.equal((src.match(/x-pf-probe-colo-(pages|render)/g) || []).length >= 2, true);
	assert.ok((pages.match(/noStoreAnywhere\(/g) || []).length >= 2, 'a probe answer from Pages is never stored');
});

// The object arms (#1277 issuecomment-7064796127): a Durable Object runs where it was first created, so a pool object
// is measured where it lives. object: the existing pool object ovf-0. object-new: a fresh probe-only object made with
// the pool's location hint (PLACEMENT_PROBE_OBJECT names it; a new value is a new object).
test('#1277 the object arms are arms, behind the same key', () => {
	for (const a of ['object', 'object-new']) {
		assert.equal(probeArm(req(a + ':' + KEY), { PLACEMENT_PROBE_KEY: KEY }), a);
		assert.equal(probeArm(req(a + ':' + KEY), {}), null, a + ' is off without a key');
	}
});
test('#1277 probeObjectName: a probe-only name, never a pool name, sanitised', () => {
	assert.equal(probeObjectName({}), 'pfprobe-a');
	assert.equal(probeObjectName({ PLACEMENT_PROBE_OBJECT: 'w1' }), 'pfprobe-w1');
	assert.equal(probeObjectName({ PLACEMENT_PROBE_OBJECT: 'Bad Name!/..' }), 'pfprobe-a', 'not [a-z0-9-]{1,16}: the default');
	assert.equal(probeObjectName({ PLACEMENT_PROBE_OBJECT: 'x'.repeat(17) }), 'pfprobe-a');
	assert.doesNotMatch(probeObjectName({ PLACEMENT_PROBE_OBJECT: 'ovf-0' }), /^ovf-/);
});
test('#1277 index.js wires the object arms: forwarded with the pool hint before the overflow decision; the object traces once', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const route = readFileSync(new URL('../page-copy.mjs', import.meta.url), 'utf8').replace(/^[\s\S]*?export function pageCacheRoute\(/, 'function pageCacheRoute(').replace(/export function storeRequestSide[\s\S]*$/, '');
	assert.match(route, /!\['direct', 'render', 'object', 'object-new'\]\.includes\(probeArm\(req, env\)\)/, 'object arms never go to the page cache');
	const ovAt = src.indexOf('const ovs = overflowSettings(env);');
	const fwd = src.indexOf("return toPhpObject(req, env, url, ctx, { name: objProbe === 'object' ? overflowName(0) : probeObjectName(env), hint: ovs.hint, overflow: true, callId: crypto.randomUUID() });");
	assert.ok(fwd > ovAt && fwd < src.indexOf('if (ovs.on && env.PHP_RUNTIME', ovAt), 'forwarded with the pool hint, before the overflow decision');
	const obj = src.slice(src.indexOf('export class PhpRuntime extends DurableObject {'));
	const at = obj.indexOf('async fetch(raw) {');
	const body = obj.slice(at, at + 2500);
	assert.match(body, /!raw\.headers\.has\(PROBE_TRACED_HEADER\)/, 'the object traces once (no recursion)');
	assert.match(body, /x-pf-probe-colo-object/);
	assert.match(body, /noStoreAnywhere\(oout\.headers\)/, 'an object probe answer is never stored');
});
