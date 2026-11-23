// node --test spikes/b2-wordpress/tests/operator-headers.test.mjs
// PHP sees a request header as $_SERVER['HTTP_' + name.toUpperCase().replace(/-/g, '_')] (php-wasm's prepare
// $_SERVER, @php-wasm/universal). So "x-oc-off", "x_oc_off" and "X_Oc-Off" all reach PHP as HTTP_X_OC_OFF. An operator
// switch must be removed, without a spike token, under EVERY spelling that maps to its PHP key.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { stripOperatorHeaders, OPERATOR_PHP_HEADERS } from '../operator-headers.mjs';

const phpKey = (name) => 'HTTP_' + name.toUpperCase().replace(/-/g, '_');
// As index.js builds it: a plain object from a real Headers, so names arrive as Headers gives them.
const asPhpGets = (pairs) => { const h = {}; new Headers(pairs).forEach((v, k) => (h[k] = v)); return h; };

test('every operator header is removed without a token, under every spelling PHP maps to the same key', () => {
	for (const name of OPERATOR_PHP_HEADERS) {
		const spellings = [name, name.replace(/-/g, '_'), name.replace('-', '_'), name.toUpperCase(), name.toUpperCase().replace(/-/g, '_')];
		for (const sp of spellings) {
			const h = stripOperatorHeaders(asPhpGets([[sp, '1'], ['accept', 'text/html']]), false);
			const left = Object.keys(h).filter((k) => phpKey(k) === phpKey(name));
			assert.deepEqual(left, [], name + ' spelled ' + sp + ' still reaches PHP as ' + phpKey(name));
			assert.equal(h.accept, 'text/html', 'other headers stay');
		}
	}
});
test('a case-only variant (X-OC-OFF) arrives lower-cased from Headers and is removed', () => {
	const h = stripOperatorHeaders(asPhpGets([['X-OC-OFF', '1']]), false);
	assert.deepEqual(Object.keys(h), []);
});
test('the helper matches the PHP mapping on its own, even for a raw object not built by Headers', () => {
	const h = stripOperatorHeaders({ 'X-OC-OFF': '1', X_MEM_TRACE: '1', 'x-pf-WC_defer': 'off', keep: 'y' }, false);
	assert.deepEqual(Object.keys(h), ['keep']);
});
test('with a valid spike token every operator header reaches PHP', () => {
	const h = stripOperatorHeaders(asPhpGets([['x-oc-off', '1'], ['x_mem_trace', '1']]), true);
	assert.deepEqual(Object.keys(h).sort(), ['x-oc-off', 'x_mem_trace']);
});
test('every HTTP_X_* header the engine PHP reads is an operator header, or named here with why it is safe', () => {
	const SAFE = {
		HTTP_X_PF_QTRACE: 'hyperdrive-qtrace.php also asks the Worker (qtraceOn), which checks the spike token itself',
		HTTP_X_PERF_ID: 'an id that only labels the memory trace, which needs x-mem-trace',
	};
	const dir = new URL('../php/', import.meta.url);
	const read = new Set();
	for (const f of readdirSync(dir)) if (f.endsWith('.php')) for (const m of readFileSync(new URL(f, dir), 'utf8').matchAll(/HTTP_X_[A-Z0-9_]+/g)) read.add(m[0]);
	const covered = new Set([...OPERATOR_PHP_HEADERS].map(phpKey));
	for (const k of read) assert.ok(covered.has(k) || SAFE[k], k + ' is read by PHP but neither stripped nor explained');
});
test('index.js strips through the helper, after the copy and before PHP runs, with no stray delete', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const copy = src.indexOf('req.headers.forEach((v, k) => (headers[k] = v));');
	const strip = src.indexOf('stripOperatorHeaders(headers, spikeOk);');
	const run = src.indexOf('await handler.request({ url: url.pathname + url.search');
	assert.ok(copy > 0 && strip > copy && run > strip);
	assert.ok(!/if \(!spikeOk\) (\{ )?delete headers\[/.test(src), 'no hand-written strip left');
});
