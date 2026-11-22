// node --test spikes/b2-wordpress/tests/force-503.test.mjs (#1328, the lead's forced-503 test; a test build, NOT for merge)
// Hypothesis: when the gateway answers 503 for a URL that has a stored guest copy, the cache serves that copy STALE, to a
// request with cart cookies too (arm (b): each leaked cookie GET lines up with a php-lock shed 503). The route forces our
// OWN shed answer (phpShedResponse) for one request, so the client's view of a 503 on a cached URL can be read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const r = (h) => new Request('https://x.example/shop/?a=1', { headers: h });
test('force503Allowed: only FORCE_503=on, a valid spike token, and x-pf-force-503: 1', async () => {
	const m = await import('../force-503.mjs');
	assert.equal(m.force503Allowed({ FORCE_503: 'on' }, true, r({ 'x-pf-force-503': '1' })), true);
	assert.equal(m.force503Allowed({}, true, r({ 'x-pf-force-503': '1' })), false, 'off by default');
	assert.equal(m.force503Allowed({ FORCE_503: 'on' }, false, r({ 'x-pf-force-503': '1' })), false, 'no spike token');
	assert.equal(m.force503Allowed({ FORCE_503: 'on' }, true, r({})), false, 'no header');
});
test('index.js: serve() answers the engine own shed response for it, after the token is read', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const s = src.slice(src.indexOf('async serve(req, env, ctx) {'), src.indexOf('async serve(req, env, ctx) {') + 6000);
	const at = s.indexOf('const forced = force503Mode(env, spikeOk, req);');
	assert.ok(at > s.indexOf('const spikeOk ='), 'after the spike token is read');
	assert.match(s, /return forced === 429 \? busy429\(phpShedResponse\(\)\) : phpShedResponse\(\);/, 'the same answer a real shed sends, or its 429 twin');
});
test('force503Mode: 1 or 503 gives the shed 503; 429 gives the 429 variant; anything else nothing', async () => {
	const m = await import('../force-503.mjs');
	const on = { FORCE_503: 'on' };
	assert.equal(m.force503Mode(on, true, r({ 'x-pf-force-503': '1' })), 503);
	assert.equal(m.force503Mode(on, true, r({ 'x-pf-force-503': '503' })), 503);
	assert.equal(m.force503Mode(on, true, r({ 'x-pf-force-503': '429' })), 429);
	assert.equal(m.force503Mode(on, true, r({ 'x-pf-force-503': '500' })), null);
	assert.equal(m.force503Mode({}, true, r({ 'x-pf-force-503': '429' })), null, 'off by default');
	assert.equal(m.force503Mode(on, false, r({ 'x-pf-force-503': '429' })), null, 'no spike token');
	const a = m.busy429(new Response('The site is busy. Please try again in a few seconds.\n', { status: 503, headers: { 'retry-after': '5', 'x-php-lock': 'shed' } }));
	assert.equal(a.status, 429);
	assert.equal(a.headers.get('retry-after'), '5');
	assert.equal(a.headers.get('x-php-lock'), 'shed', 'the same headers as the shed');
	assert.equal(await a.text(), 'The site is busy. Please try again in a few seconds.\n', 'the same body');
});
