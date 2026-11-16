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
import { checks, engine, engineUnderTest, upstreamRaw, asyncTableEntries } from './engine-contract.mjs';

const target = engineUnderTest();
const raw = upstreamRaw(target.expect);
const NO_PATCH = new Set(['opcache: a script too big for shared memory takes the file-cache fallback', 'opcache: the inheritance cache links classes across cached files', 'extensions: exactly the expected list', 'allocator: USE_ZEND_ALLOC=0 is honoured', 'exports: the request entry points are promising', 'link: dylink section and export count as expected', 'fibers: start() does not abort the runtime', 'memory: without reuse the loader counts and checks nothing per call', 'memory: the reuse choice is fixed at init', 'memory: the reuse choice is fixed at init, for lazily built wrappers and callbacks too']);

for (const [name, check] of Object.entries(checks)) {
	test('holds on ' + target.name + ': ' + name, async () => { await check(target); });
}

for (const [name, check] of Object.entries(checks)) {
	if (NO_PATCH.has(name)) continue;
	test('goes red on the unpatched upstream artifact: ' + name, async () => {
		await assert.rejects(async () => check(raw), assert.AssertionError);
	});
}

// #603 (#705 review, finding 8): each guard of the reuse loader, broken on purpose, turns its check red.
const mutant = (from, to) => { const js = target.js.split(from).join(to); assert.notEqual(js, target.js, 'the mutation applies: ' + from); return { ...target, js, loaderFile: null }; };
test('goes red on a mutation: without reuse (the reuse guards installed unconditionally)', async () => {
	await assert.rejects(async () => checks['memory: without reuse the loader counts and checks nothing per call'](mutant("var pfReuse = !!Module['pagefeatherReuse'];", 'var pfReuse = true;')), assert.AssertionError);
});
test('goes red on a mutation: the in-flight count (never incremented)', async () => {
	await assert.rejects(async () => checks['memory: promising calls in flight are counted'](mutant("Module['pfInFlight'] = (Module['pfInFlight'] || 0) + 1;", '')), assert.AssertionError);
});
test('goes red on a mutation: the promising door admits a new call while one is in flight (the old rule)', async () => {
	// both doors (the export wrapper and the promising entry) back to "open while a call is in flight"
	await assert.rejects(async () => checks['memory: a retired runtime refuses every new call, even with a call in flight'](mutant("if (Module['pfDead']) throw new Error", "if (Module['pfDead'] && !(Module['pfInFlight'] > 0)) throw new Error")), assert.AssertionError);
});
test('goes red on a mutation: callUserCallback not guarded', async () => {
	await assert.rejects(async () => checks['memory: a retired runtime runs no callback (its sleep wake is refused)'](mutant("(pfReuse && Module['pfDead'])", 'false')), assert.AssertionError);
});
test('goes red on a mutation (the #724 reviewer\'s): the promising wrapper reads the Module option when it is built', async (t) => {
	// the door this mutant breaks exists only where the table holds async exports (the npm engine); the lean arms have none
	if ((await asyncTableEntries(target)) === 0) return t.skip('no async export in this engine\'s function table: no lazily built promising wrapper to break (the npm arm runs this)');
	await assert.rejects(async () => checks['memory: the reuse choice is fixed at init, for lazily built wrappers and callbacks too'](mutant('if (!pfReuse) return pfPromising;', "if (!Module['pagefeatherReuse']) return pfPromising;")), assert.AssertionError);
});
test('goes red on a mutation (the #724 reviewer\'s): callUserCallback reads the Module option at each call', async () => {
	const m = mutant("(pfReuse && Module['pfDead'])", "(Module['pagefeatherReuse'] && Module['pfDead'])");
	await assert.rejects(async () => checks['memory: the reuse choice is fixed at init, for lazily built wrappers and callbacks too']({ ...target }, { engine: m }), assert.AssertionError);
});
test('goes red on a mutation: the reuse option read per wrapper, not once at init', async () => {
	await assert.rejects(async () => checks['memory: the reuse choice is fixed at init'](mutant('if (!pfReuse) return pfPromising;', "if (!Module['pagefeatherReuse']) return pfPromising;")), assert.AssertionError);
});

test('goes red on a mutation: extensions (one extension missing from the expectation)', async () => {
	const exp = { ...target.expect, extensions: target.expect.extensions.filter((x) => x !== 'pdo_sqlite') };
	assert.equal(exp.extensions.length, target.expect.extensions.length - 1, 'the mutation removed pdo_sqlite');
	await assert.rejects(async () => checks['extensions: exactly the expected list']({ ...target, expect: exp, loaderFile: null }), assert.AssertionError);
});

test('goes red on a mutation: inheritance cache (OPcache turned off for the request)', async () => {
	await assert.rejects(async () => checks['opcache: the inheritance cache links classes across cached files'](target, { noOpcache: true }), assert.AssertionError);
});

test('goes red on a mutation: file-cache fallback (shared memory big enough that the script fits)', async () => {
	await assert.rejects(async () => checks['opcache: a script too big for shared memory takes the file-cache fallback'](target, { bigShm: true }), assert.AssertionError);
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

test('goes red on a mutation: fibers (the npm engine, whose getcontext aborts, judged as the lean engine)', async () => {
	const exp = { ...raw.expect, static: { ...raw.expect.static, dylink: false } };
	await assert.rejects(async () => checks['fibers: start() does not abort the runtime']({ ...raw, expect: exp, loaderFile: null }), assert.AssertionError);
});

test('goes red on a mutation: link (the opposite dylink expectation, and today\'s 6,603 exports under a bound of 100)', async () => {
	const flipped = { ...target.expect, static: { ...target.expect.static, dylink: !target.expect.static.dylink } };
	await assert.rejects(async () => checks['link: dylink section and export count as expected']({ ...target, expect: flipped }), assert.AssertionError);
	const bounded = { ...raw.expect, static: { dylink: true, maxExports: 100 } };
	await assert.rejects(async () => checks['link: dylink section and export count as expected']({ ...raw, expect: bounded }), assert.AssertionError);
});
