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
	assert.ok(php.includes("array( 'woo', 'wcadmin', 'wcfeatures', 'preload', 'updates', 'dashboard', 'notices', 'l10n', 'restindex' )"));
	assert.ok(src.includes("if (m.memMark) { console.log(JSON.stringify({ m: 'mem-mark', ...(typeof m.id === 'string' && MEM_ID_RE.test(m.id) ? { id: m.id } : {}), k: m.memMark })); return '1'; }"));
});

test('build.sh copies the trace mu-plugin', () => {
	const build = readFileSync(new URL('../build.sh', import.meta.url), 'utf8');
	assert.match(build, /cp [^\n]*php\/mem-trace\.php[^\n]*"\$wp\/wp-content\/mu-plugins\/"/);
});

test('the reset lines carry the operator id, and only for an operator request with a safe id', () => {
	assert.equal((src.match(/\.\.\.memIdOf\(req, env\)/g) || []).length, 2, 'both reset log lines carry memIdOf');
	assert.ok(src.includes("return id && MEM_ID_RE.test(id) && perfHeadersAllowed(req, env) ? { id } : {};"));
	assert.ok(src.includes("const MEM_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;"));
});

test('plugin=<slug> switches any one plugin off, by a safe directory name only', () => {
	assert.ok(php.includes("preg_match( '/^plugin=([a-z0-9][a-z0-9_-]{0,63})$/', $o, $mm )"));
	assert.ok(php.includes("return ! in_array( strtok( (string) $file, '/' ), $skyphusion_mem_plugins, true );"));
	// woo is the same filter, for the woocommerce directory.
	assert.ok(php.includes("$skyphusion_mem_plugins[] = 'woocommerce';"));
});
