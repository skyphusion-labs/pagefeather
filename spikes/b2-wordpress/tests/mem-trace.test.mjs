import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PERF_HEADERS, scrubPerfHeaders } from '../perf-headers.mjs';

// index.js cannot be imported under node (it loads php-wasm), so these read its source, as
// site-lock.test.mjs does. The memory trace (#434) is operator-only end to end.
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const php = readFileSync(new URL('../php/mem-trace.php', import.meta.url), 'utf8');

test('x-mem-trace and x-mem-off reach PHP only with a valid spike token', () => {
	assert.ok(src.includes("if (!spikeOk) { delete headers['x-mem-trace']; delete headers['x-mem-off']; }"));
	const del = src.indexOf("delete headers['x-mem-trace']");
	const run = src.indexOf('await handler.request({ url: url.pathname + url.search');
	assert.ok(del > 0 && run > del, 'the headers must be deleted before PHP runs');
});

test('the trace header is set only with a valid spike token, and cleared every request', () => {
	assert.ok(src.includes("if (spikeOk && lastMemTrace) out.set('x-mem-trace', JSON.stringify(lastMemTrace).slice(0, 7900));"));
	assert.ok(/lastMemTrace = null;\n\t+const r = await handler\.request\(/.test(src), 'reset before PHP runs');
	assert.ok(src.includes("if (m.memTrace) { lastMemTrace = m.memTrace; return '1'; }"));
});

test('x-mem-trace is a perf header: a visitor never gets it', () => {
	assert.ok(PERF_HEADERS.includes('x-mem-trace'));
	const res = new Response('x', { headers: { 'x-mem-trace': '{"v":1}', 'content-type': 'text/plain' } });
	assert.equal(scrubPerfHeaders(res, false).headers.get('x-mem-trace'), null);
	assert.equal(scrubPerfHeaders(res, true).headers.get('x-mem-trace'), '{"v":1}');
});

test('the mu-plugin returns at once without the trace header, and only knows the listed switches', () => {
	const guard = php.indexOf("if ( empty( $_SERVER['HTTP_X_MEM_TRACE'] ) || ! function_exists( 'post_message_to_js' ) ) {");
	assert.ok(guard > 0 && guard < php.indexOf('add_action('), 'the guard must come before any hook');
	assert.ok(php.includes("array( 'woo', 'wcadmin', 'wcfeatures', 'preload', 'updates', 'dashboard', 'notices', 'l10n' )"));
	assert.ok(src.includes("if (m.memMark) { console.log(JSON.stringify({ m: 'mem-mark', k: m.memMark })); return '1'; }"));
});

test('build.sh copies the trace mu-plugin', () => {
	const build = readFileSync(new URL('../build.sh', import.meta.url), 'utf8');
	assert.match(build, /cp [^\n]*php\/mem-trace\.php[^\n]*"\$wp\/wp-content\/mu-plugins\/"/);
});
