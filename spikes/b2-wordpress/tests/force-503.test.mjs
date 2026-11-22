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
	const at = s.indexOf('if (force503Allowed(env, spikeOk, req)) {');
	assert.ok(at > s.indexOf('const spikeOk ='), 'after the spike token is read');
	assert.match(s, /if \(force503Allowed\(env, spikeOk, req\)\) \{\n\t\t\tconsole\.log\(JSON\.stringify\(\{ m: 'force-503', path: url\.pathname \}\)\);\n\t\t\treturn phpShedResponse\(\);/, 'the same 503 a real shed sends');
});
