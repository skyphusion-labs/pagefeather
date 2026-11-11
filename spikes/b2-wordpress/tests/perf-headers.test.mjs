import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PERF_HEADERS, perfHeadersAllowed, scrubPerfHeaders } from '../perf-headers.mjs';

const TOKEN = 'spike-token-value';
const req = (headers = {}) => new Request('https://site.example/', { headers });
const answer = () => new Response('<html>page</html>', {
	status: 200,
	headers: Object.fromEntries([['content-type', 'text/html'], ['cache-control', 'public, max-age=60'], ...PERF_HEADERS.map((h) => [h, '1'])]),
});

test('the list names the timing, statistics and runtime headers', () => {
	for (const h of ['x-oc-stats', 'x-db-rows', 'x-perf-worker', 'server-timing', 'x-php-object', 'x-perf-queue', 'x-d1-calls', 'x-d1-ms', 'x-d1-failures', 'x-php-ms', 'x-r2-ops']) {
		assert.ok(PERF_HEADERS.includes(h), h);
	}
});

test('a request with no token gets none of them, and keeps the page and its other headers', async () => {
	const env = { SPIKE_TOKEN: TOKEN };
	const out = scrubPerfHeaders(answer(), perfHeadersAllowed(req(), env));
	for (const h of PERF_HEADERS) assert.equal(out.headers.get(h), null, h);
	assert.equal(out.headers.get('content-type'), 'text/html');
	assert.equal(out.headers.get('cache-control'), 'public, max-age=60');
	assert.equal(out.status, 200);
	assert.equal(await out.text(), '<html>page</html>');
});

test('a wrong token gets none of them', () => {
	const env = { SPIKE_TOKEN: TOKEN };
	const out = scrubPerfHeaders(answer(), perfHeadersAllowed(req({ 'x-spike-token': 'nope' }), env));
	for (const h of PERF_HEADERS) assert.equal(out.headers.get(h), null, h);
});

test('with no SPIKE_TOKEN configured, an absent or empty header never matches', () => {
	assert.equal(perfHeadersAllowed(req(), {}), false);
	assert.equal(perfHeadersAllowed(req({ 'x-spike-token': '' }), { SPIKE_TOKEN: '' }), false);
	assert.equal(perfHeadersAllowed(req({ 'x-spike-token': 'undefined' }), {}), false);
	assert.equal(perfHeadersAllowed(req(), undefined), false);
});

test('the valid token keeps every header', () => {
	const env = { SPIKE_TOKEN: TOKEN };
	const res = answer();
	const out = scrubPerfHeaders(res, perfHeadersAllowed(req({ 'x-spike-token': TOKEN }), env));
	assert.equal(out, res);
	for (const h of PERF_HEADERS) assert.equal(out.headers.get(h), '1', h);
});

test('PERF_HEADERS=on keeps them for every request, and only that exact value', () => {
	assert.equal(perfHeadersAllowed(req(), { PERF_HEADERS: 'on' }), true);
	assert.equal(perfHeadersAllowed(req(), { PERF_HEADERS: 'off' }), false);
	assert.equal(perfHeadersAllowed(req(), { PERF_HEADERS: 'true' }), false);
});

test('a response that carries none of them is returned untouched', () => {
	const res = new Response('x', { headers: { 'content-type': 'text/plain' } });
	assert.equal(scrubPerfHeaders(res, false), res);
});

// index.js cannot be imported under node (it loads php-wasm), so these read its source.
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('every answer of the Worker passes through the scrub', () => {
	assert.match(src, /import \{ perfHeadersAllowed, scrubPerfHeaders \} from '\.\/perf-headers\.mjs';/);
	assert.match(src, /async fetch\(req, env, ctx\) \{\s*return scrubPerfHeaders\(await this\.serve\(req, env, ctx\), perfHeadersAllowed\(req, env\)\);/);
	assert.match(src, /async serve\(req, env, ctx\) \{\s*ENV = env;/);
});

test('both entrypoints reach the Worker through site.fetch, the scrubbed one', () => {
	assert.equal((src.match(/site\.fetch\(/g) || []).length, 2);
	assert.equal((src.match(/site\.serve\(/g) || []).length, 0);
});

test('the cached entrypoint never lets the edge keep an operator answer', () => {
	assert.match(src, /if \(req\.headers\.has\('x-spike-token'\)\) out\.headers\.set\('cache-control', 'private, no-store'\);/);
});
