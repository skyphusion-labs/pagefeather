// node --test spikes/b2-wordpress/tests/conformance-reset-gate.test.mjs (#1401)
// The throwaway marker's global-styles reset (tests/conformance/php/pf-conformance-throwaway.php) deletes posts, so
// it needs the throwaway AND the spike token. The token half lives here: x-pf-conformance-reset reaches PHP only when
// x-spike-token matched SPIKE_TOKEN. index.js cannot be imported under node (php-wasm), so this reads its source.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripOperatorHeaders, OPERATOR_PHP_HEADERS } from '../operator-headers.mjs';
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const marker = readFileSync(new URL('../../../tests/conformance/php/pf-conformance-throwaway.php', import.meta.url), 'utf8');

test('x-pf-conformance-reset is removed before PHP runs unless the spike token is valid, under every spelling', () => {
	assert.ok(OPERATOR_PHP_HEADERS.has('x-pf-conformance-reset'), 'it is an operator header');
	for (const name of ['x-pf-conformance-reset', 'x_pf_conformance_reset', 'X-PF-CONFORMANCE-RESET', 'x-pf_conformance-reset'])
		assert.deepEqual(Object.keys(stripOperatorHeaders({ [name]: '1' }, false)), [], name);
	assert.deepEqual(stripOperatorHeaders({ 'x-pf-conformance-reset': '1' }, true), { 'x-pf-conformance-reset': '1' }, 'kept with the token');
	const strip = src.indexOf('stripOperatorHeaders(headers, spikeOk);');
	const build = src.indexOf('req.headers.forEach((v, k) => (headers[k] = v));');
	const run = src.indexOf('await handler.request({ url: url.pathname + url.search');
	assert.ok(build > 0 && strip > build && run > strip, 'after the headers are copied, before PHP runs');
	assert.equal((src.match(/await handler\.request\(/g) || []).length, 1, 'one way into PHP, so no path skips the strip');
});
test('every spikeOk handed to handle() is the token compare', () => {
	const defs = src.match(/const spikeOk = [^;]+;/g) || [];
	assert.ok(defs.length >= 2, 'the object path and the worker path');
	for (const d of defs) assert.equal(d, "const spikeOk = Boolean(env.SPIKE_TOKEN) && req.headers.get('x-spike-token') === env.SPIKE_TOKEN;");
});
test('the PHP route needs the header AND the capability, and only the marker registers it', () => {
	assert.match(marker, /'HTTP_X_PF_CONFORMANCE_RESET'\] \) && '1' === \$_SERVER\['HTTP_X_PF_CONFORMANCE_RESET'\]\s*&& current_user_can\( 'edit_theme_options' \)/);
	assert.match(marker, /'permission_callback' => 'pf_conformance_reset_allowed'/);
	const engine = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.ok(!engine.includes('reset-global-styles'), 'the engine does not register or call it');
});
