import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PERF_HEADERS, perfHeadersAllowed, scrubPerfHeaders, isOperatorRequest, noStoreAnywhere, operatorNoStore } from '../perf-headers.mjs';

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
	assert.match(src, /import \{ perfHeadersAllowed, scrubPerfHeaders, isOperatorRequest, noStoreAnywhere, operatorNoStore \} from '\.\/perf-headers\.mjs';/);
	assert.match(src, /async fetch\(req, env, ctx\) \{\s*(\/\/[^\n]*\n\s*)?return operatorNoStore\(scrubPerfHeaders\(await this\.serve\(req, env, ctx\), perfHeadersAllowed\(req, env\)\), req\);/);
	assert.match(src, /async serve\(req, env, ctx\) \{\s*ENV = env;/);
});

test('both entrypoints reach the Worker through site.fetch, the scrubbed one', () => {
	assert.equal((src.match(/site\.fetch\(/g) || []).length, 2);
	assert.equal((src.match(/site\.serve\(/g) || []).length, 0);
});

test('the cached entrypoint never lets the edge keep an operator answer', () => {
	// cache-control alone was the old line, and it was not enough: the edge obeys
	// cloudflare-cdn-cache-control over it.
	assert.match(src, /if \(isOperatorRequest\(req\)\) noStoreAnywhere\(out\.headers\);/);
});

// Never store operator responses at the edge: a page answer as the page cache marks it
// (cloudflare-cdn-cache-control, which the edge obeys over cache-control), to a request with the
// token header, must leave with no directive that lets any cache keep it.
const edgeCacheable = (status = 200, extra = {}) => new Response(status === 301 ? null : '<html>page</html>', {
	status,
	headers: { 'content-type': 'text/html', 'cache-control': 'no-cache', 'cloudflare-cdn-cache-control': 'max-age=120, stale-while-revalidate=600', 'cdn-cache-control': 'max-age=60', 'cache-tag': 'wp-pages', ...extra, ...Object.fromEntries(PERF_HEADERS.map((h) => [h, '1'])) },
});
function assertNoEdgeStore(h) {
	assert.equal(h.get('cloudflare-cdn-cache-control'), 'no-store');
	assert.equal(h.get('cdn-cache-control'), null);
	assert.equal(h.get('cache-tag'), null);
	assert.equal(h.get('cache-control'), 'private, no-store');
	for (const v of [h.get('cloudflare-cdn-cache-control'), h.get('cache-control')]) assert.doesNotMatch(v, /max-age|s-maxage|public|stale/);
}

test('an operator request is one with the token header, valid or not', () => {
	assert.equal(isOperatorRequest(req({ 'x-spike-token': TOKEN })), true);
	assert.equal(isOperatorRequest(req({ 'x-spike-token': 'wrong' })), true);
	assert.equal(isOperatorRequest(req()), false);
});

test('a token response carries no edge cache directive', async () => {
	const out = operatorNoStore(scrubPerfHeaders(edgeCacheable(), true), req({ 'x-spike-token': TOKEN }));
	assertNoEdgeStore(out.headers);
	assert.equal(out.headers.get('x-perf-queue'), '1', 'the operator still gets the performance headers');
	assert.equal(await out.text(), '<html>page</html>');
});

test('the redirect path: a 301 and a 302 to a token request carry no edge cache directive either', () => {
	for (const status of [301, 302]) {
		const out = operatorNoStore(edgeCacheable(status, { location: 'https://site.example/?post_type=product' }), req({ 'x-spike-token': TOKEN }));
		assert.equal(out.status, status);
		assert.equal(out.headers.get('location'), 'https://site.example/?post_type=product');
		assertNoEdgeStore(out.headers);
	}
});

test('a visitor response keeps its edge caching (the page cache still works)', () => {
	const r = edgeCacheable();
	assert.equal(operatorNoStore(r, req()), r, 'returned as is');
	assert.equal(r.headers.get('cloudflare-cdn-cache-control'), 'max-age=120, stale-while-revalidate=600');
});

test('noStoreAnywhere works on a Headers in place', () => {
	const h = new Headers({ 'cloudflare-cdn-cache-control': 'max-age=120', 'cache-tag': 'wp-pages' });
	noStoreAnywhere(h);
	assertNoEdgeStore(h);
});

test('index.js: an operator request never reaches the cached entrypoint, and both entrypoints mark its answer', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const route = src.slice(src.indexOf('function pageCacheRoute('), src.indexOf('function pageCacheHeaders('));
	assert.match(route, /!isOperatorRequest\(req\)/, 'pageCacheRoute refuses an operator request');
	assert.match(src, /return operatorNoStore\(scrubPerfHeaders\(await this\.serve\(req, env, ctx\), perfHeadersAllowed\(req, env\)\), req\);/, 'the site answer is marked');
	const pages = src.slice(src.indexOf('export class Pages extends WorkerEntrypoint'), src.indexOf('async purge(tags)'));
	assert.match(pages, /if \(isOperatorRequest\(req\)\) noStoreAnywhere\(out\.headers\);/, 'the cached entrypoint marks it too');
	assert.ok(!/out\.headers\.set\('cache-control', 'private, no-store'\);\s*return out;\s*}\s*\/\/ An RPC/.test(pages), 'not cache-control alone');
});
