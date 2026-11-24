import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { PERF_HEADERS, scrubPerfHeaders } from '../perf-headers.mjs';

// index.js cannot be imported under node (it loads php-wasm), so these read its source, as
// site-lock.test.mjs does. The memory trace (#434) is operator-only end to end.
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const php = readFileSync(new URL('../php/mem-trace.php', import.meta.url), 'utf8');

test('x-mem-trace and x-mem-off reach PHP only with a valid spike token', () => {
	const ops = readFileSync(new URL('../operator-headers.mjs', import.meta.url), 'utf8');
	assert.ok(ops.includes("'x-mem-trace'") && ops.includes("'x-mem-off'"), 'both are operator headers');
	const del = src.indexOf('stripOperatorHeaders(headers, spikeOk);');
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
	assert.ok(php.includes("array( 'woo', 'wcadmin', 'wcfeatures', 'wcblocks', 'preload', 'updates', 'dashboard', 'notices', 'l10n' )"));
	assert.ok(src.includes("if (m.memMark) { console.log(JSON.stringify({ m: 'mem-mark', ...(typeof m.id === 'string' && MEM_ID_RE.test(m.id) ? { id: m.id } : {}), k: m.memMark })); return '1'; }"));
});

test('build.sh copies the trace mu-plugin', () => {
	const build = readFileSync(new URL('../build.sh', import.meta.url), 'utf8');
	// The mu-plugin list is one entry per line (MU_PLUGINS, build.sh), copied into mu-plugins in one cp.
	assert.match(build, /MU_PLUGINS=\(\n(\t[^\n]+\n)*\tphp\/mem-trace\.php\n(\t[^\n]+\n)*\)\ncp "\$\{MU_PLUGINS\[@\]\}" "\$wp\/wp-content\/mu-plugins\/"/);
});

test('the reset lines carry the operator id, and only for an operator request with a safe id', () => {
	// The two reset lines, named rather than counted: the write-loss lines spread memIdOf too (#596).
	const lines = src.split('\n');
	const retryLine = lines.find((l) => l.includes('object-deadline-retry') && l.includes('isolate-reset-retry'));
	assert.ok(retryLine, 'object-deadline-retry | isolate-reset-retry');
	assert.match(retryLine, /\.\.\.\(await memIdOf\(req, env\)\)/, 'retry log');
	const tagLine = lines.find((l) => l.includes("const tag = reset ? 'isolate-reset' : kind === 'internal' ? 'platform-internal' : 'overloaded'"));
	assert.ok(tagLine, "platform-internal");
	const resetLine = lines.find((l) => l.includes("{ m: tag,") && l.includes("memIdOf(req, env)"));
	assert.ok(resetLine, "m: tag");
	assert.match(resetLine, /\.\.\.\(await memIdOf\(req, env\)\)/, 'reset log');
	assert.ok(src.includes("return id && MEM_ID_RE.test(id) && await perfHeadersAllowed(req, env) ? { id } : {};"));
	assert.ok(src.includes("const MEM_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;"));
});

test('plugin=<slug> switches any one plugin off, by a safe directory name only', () => {
	assert.ok(php.includes("preg_match( '/^plugin=([a-z0-9][a-z0-9_-]{0,63})$/', $o, $mm )"));
	assert.ok(php.includes("return ! in_array( strtok( (string) $file, '/' ), $skyphusion_mem_plugins, true );"));
	// woo is the same filter, for the woocommerce directory.
	assert.ok(php.includes("$skyphusion_mem_plugins[] = 'woocommerce';"));
});

test('wcblocks turns off WooCommerce block registration through its own gate, and only that', () => {
	const at = php.indexOf("if ( in_array( 'wcblocks', $skyphusion_mem_off, true ) ) {");
	assert.ok(at > 0, 'no wcblocks switch');
	const body = php.slice(at, php.indexOf('}', at));
	assert.ok(body.includes("add_filter( 'woocommerce_should_register_blocks', '__return_false', PHP_INT_MAX );"));
	assert.equal((body.match(/add_filter|add_action/g) || []).length, 1, 'wcblocks hooks exactly one filter');
});
