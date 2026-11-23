// node --test spikes/b2-wordpress/tests/r2-trace.test.mjs
// #1424 step 1: the per-call R2 bridge trace is operator-only end to end. index.js cannot be imported under node
// (it loads php-wasm), so these read its source, as mem-trace.test.mjs does. The PHP half is r2-trace-test.php.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PERF_HEADERS, scrubPerfHeaders } from '../perf-headers.mjs';
import { OPERATOR_PHP_HEADERS, stripOperatorHeaders } from '../operator-headers.mjs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const php = readFileSync(new URL('../php/r2-uploads.php', import.meta.url), 'utf8');

test('x-pf-r2-trace is an operator header: removed without a spike token, kept with one', () => {
	assert.ok(OPERATOR_PHP_HEADERS.has('x-pf-r2-trace'));
	assert.deepEqual(Object.keys(stripOperatorHeaders({ 'x-pf-r2-trace': '1', accept: 'x' }, false)), ['accept']);
	assert.deepEqual(Object.keys(stripOperatorHeaders({ 'x-pf-r2-trace': '1' }, true)), ['x-pf-r2-trace']);
});

test('the trace response header is a perf header: a visitor never gets it', () => {
	assert.ok(PERF_HEADERS.includes('x-r2-trace'));
	const res = new Response('x', { headers: { 'x-r2-trace': '{"v":1}' } });
	assert.equal(scrubPerfHeaders(res, false).headers.get('x-r2-trace'), null);
	assert.equal(scrubPerfHeaders(res, true).headers.get('x-r2-trace'), '{"v":1}');
});

test('the Worker keeps the trace only for the request, sets the header only with a valid spike token, and clears it', () => {
	assert.ok(src.includes("if (m.r2Trace) { lastR2Trace = m.r2Trace; return '1'; }"));
	assert.ok(src.includes("if (spikeOk && lastR2Trace) out.set('x-r2-trace', JSON.stringify(lastR2Trace).slice(0, 7900));"));
	assert.ok(src.indexOf('lastR2Trace = null; // #1424') > 0 && src.indexOf('lastR2Trace = null; // #1424') < src.indexOf('const r = await handler.request('), 'reset before PHP runs');
	assert.ok(/x-r2-trace'[^\n]*\n\t+lastR2Trace = null;/.test(src), 'cleared after it is read');
});

test('PHP records only on the operator header, and only the bridge call (not a cached head)', () => {
	assert.ok(php.includes("! empty( $_SERVER['HTTP_X_PF_R2_TRACE'] )"));
	assert.ok(php.includes("array( 'r2Trace' => "));
});

test('the trace is set on exactly one response header, and never logged', () => {
	assert.equal(src.split("out.set('x-r2-trace'").length - 1, 1);
	for (const line of src.split('\n')) if (/console\.(log|error|warn|info)/.test(line)) assert.ok(!/r2Trace|R2Trace|r2-trace/.test(line), 'the trace is logged: ' + line.trim());
});
test('PHP trace gate is the header with a truthy value (0 and empty are off)', () => {
	assert.ok(php.includes("! empty( $_SERVER['HTTP_X_PF_R2_TRACE'] )"));
});
