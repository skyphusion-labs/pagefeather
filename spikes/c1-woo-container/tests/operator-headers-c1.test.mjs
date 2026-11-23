// node --test spikes/c1-woo-container/tests/operator-headers-c1.test.mjs
// c1 forwards request headers to its container. b2 strips the operator switches (operator-headers.mjs) unless the
// spike token is valid; c1 must do the same, with the SAME helper, on every path that reaches the container (#1432).
// worker.js imports cloudflare:workers, so this reads its source, as the other c1 tests do.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const at = src.indexOf('export default {');
const fetchFn = src.slice(at);

test('c1 imports the one shared helper from b2 (no second copy)', () => {
	assert.match(src, /import \{ stripOperatorHeaders \} from '\.\.\/b2-wordpress\/operator-headers\.mjs';/);
	assert.ok(!/function stripOperatorHeaders\(/.test(src), 'no local copy');
});
test('the strip runs on the request before any path reaches the container, only without a valid token', () => {
	const spike = fetchFn.indexOf('const spikeOk =');
	const strip = fetchFn.indexOf('if (!spikeOk) req = withoutOperatorHeaders(req);');
	const cacheable = fetchFn.indexOf('storefrontCacheable(req, url)');
	const store = fetchFn.indexOf('store(env).fetch(req)');
	assert.ok(spike > 0 && strip > spike, 'after spikeOk is known, gated on it');
	assert.ok(strip < cacheable && strip < store, 'before both forward paths');
});
test('the helper strips through the shared function and rebuilds the request with the stripped headers', () => {
	const h = src.indexOf('function withoutOperatorHeaders(req)');
	assert.ok(h > 0 && h < at);
	const body = src.slice(h, src.indexOf('\n}\n', h));
	assert.ok(body.includes('stripOperatorHeaders(h, false)'));
	assert.ok(body.includes('new Request(req, { headers: h })'));
});
