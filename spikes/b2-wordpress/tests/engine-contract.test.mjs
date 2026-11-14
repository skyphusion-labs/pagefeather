// node --test spikes/b2-wordpress/tests/engine-contract.test.mjs (#582). Needs npm ci and ./prepare.sh
// in spikes/b2-wordpress, and a node with JSPI (24 or later). The engine under test is vendor/ by
// default; ENGINE_JS, ENGINE_WASM and ENGINE_EXPECT point it at another build (our own, from S1 on).
//
// Part 1: every contract check passes on the engine under test.
// Part 2: each check can fail. Run on the UNPATCHED upstream 3.1.62 artifact (node_modules), every
// check that a prepare.sh patch exists for must fail there: that artifact is the real thing each
// patch changes. The three checks with no patch behind them fail on a targeted mutation instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checks, engine, engineUnderTest, upstreamRaw } from './engine-contract.mjs';

const target = engineUnderTest();
const raw = upstreamRaw(target.expect);
const NO_PATCH = new Set(['extensions: exactly the expected list', 'allocator: USE_ZEND_ALLOC=0 is honoured', 'exports: the request entry points are promising', 'link: dylink section and export count as expected']);

for (const [name, check] of Object.entries(checks)) {
	test('holds on ' + target.name + ': ' + name, async () => { await check(target); });
}

for (const [name, check] of Object.entries(checks)) {
	if (NO_PATCH.has(name)) continue;
	test('goes red on the unpatched upstream artifact: ' + name, async () => {
		await assert.rejects(async () => check(raw), assert.AssertionError);
	});
}

test('goes red on a mutation: extensions (one extension missing from the expectation)', async () => {
	const exp = { ...target.expect, extensions: target.expect.extensions.filter((x) => x !== 'pdo_sqlite') };
	assert.equal(exp.extensions.length, target.expect.extensions.length - 1, 'the mutation removed pdo_sqlite');
	await assert.rejects(async () => checks['extensions: exactly the expected list']({ ...target, expect: exp, loaderFile: null }), assert.AssertionError);
});

test('goes red on a mutation: allocator (USE_ZEND_ALLOC=1)', async () => {
	await assert.rejects(async () => checks['allocator: USE_ZEND_ALLOC=0 is honoured'](target, { env: { USE_ZEND_ALLOC: '1' } }), assert.AssertionError);
});

test('goes red on a mutation: exports (wasm_sapi_handle_request not promising)', async () => {
	const m = /var exportPattern =\s*\/\^\(([^)]*)\)\$\//.exec(target.js);
	assert.ok(m && m[1].includes('wasm_sapi_handle_request'), 'the pattern names it');
	const js = target.js.replace(m[0], m[0].replace('wasm_sapi_handle_request', 'wasm_sapi_handle_requestX'));
	await assert.rejects(async () => checks['exports: the request entry points are promising']({ ...target, js }), assert.AssertionError);
});

test('goes red on a mutation: link (the opposite dylink expectation, and today\'s 6,603 exports under a bound of 100)', async () => {
	const flipped = { ...target.expect, static: { ...target.expect.static, dylink: !target.expect.static.dylink } };
	await assert.rejects(async () => checks['link: dylink section and export count as expected']({ ...target, expect: flipped }), assert.AssertionError);
	const bounded = { ...raw.expect, static: { dylink: true, maxExports: 100 } };
	await assert.rejects(async () => checks['link: dylink section and export count as expected']({ ...raw, expect: bounded }), assert.AssertionError);
});
