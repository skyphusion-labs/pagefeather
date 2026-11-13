// node --test spikes/b2-wordpress/tests/pre-recycle.test.mjs (#394 (2), PRE_RECYCLE_MIB)
// The decision is a pure module (pre-recycle.mjs) and is tested directly. Its wiring in index.js is
// read from the source, as release-runtime.test.mjs does (index.js loads php-wasm and cannot be
// imported under node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { preRecycleMib, heavyAdminGet, shouldPreRecycle } from '../pre-recycle.mjs';

const MIB = 1048576;

test('the line: off unless PRE_RECYCLE_MIB is an integer from 32 to 1024', () => {
	assert.equal(preRecycleMib({}), null);
	assert.equal(preRecycleMib(undefined), null);
	assert.equal(preRecycleMib({ PRE_RECYCLE_MIB: '' }), null);
	assert.equal(preRecycleMib({ PRE_RECYCLE_MIB: '90' }), 90);
	assert.equal(preRecycleMib({ PRE_RECYCLE_MIB: '32' }), 32);
	assert.equal(preRecycleMib({ PRE_RECYCLE_MIB: '1024' }), 1024);
	for (const bad of ['31', '1025', '9', 'abc', '90.5', '-90', ' 90', '0x5a', 'on']) {
		assert.equal(preRecycleMib({ PRE_RECYCLE_MIB: bad }), null, bad);
	}
});

test('the heavy class: admin screen GETs only', () => {
	for (const [p, q] of [['/wp-admin/post-new.php', ''], ['/wp-admin/post.php', '?post=5&action=edit'], ['/wp-admin/', ''], ['/wp-admin', ''], ['/wp-admin/index.php', ''], ['/wp-admin/edit.php', '?post_type=page'], ['/wp-admin/profile.php', '']]) {
		assert.equal(heavyAdminGet('GET', p, q), true, p + q);
	}
	assert.equal(heavyAdminGet('POST', '/wp-admin/post-new.php', ''), false, 'a POST is the screen saving, not loading');
	assert.equal(heavyAdminGet('HEAD', '/wp-admin/post-new.php', ''), false);
	for (const [p, q] of [['/wp-admin/admin-ajax.php', '?action=heartbeat'], ['/wp-admin/async-upload.php', ''], ['/wp-admin/admin-post.php', ''], ['/wp-admin/css/x.css', ''], ['/wp-json/wp/v2/pages', ''], ['/', '?rest_route=/wp/v2/pages'], ['/', ''], ['/shop/', ''], ['/wp-login.php', ''], ['/wp-cron.php', '']]) {
		assert.equal(heavyAdminGet('GET', p, q), false, p + q);
	}
});

test('the decision: at or above the line, on the heavy class, only when on', () => {
	const req = { method: 'GET', pathname: '/wp-admin/post-new.php', search: '' };
	assert.equal(shouldPreRecycle({ ...req, lineMib: 90, wasmBytes: 97 * MIB }), true, 'the measured warm runtime');
	assert.equal(shouldPreRecycle({ ...req, lineMib: 90, wasmBytes: 90 * MIB }), true, 'at the line');
	assert.equal(shouldPreRecycle({ ...req, lineMib: 90, wasmBytes: 90 * MIB - 1 }), false);
	assert.equal(shouldPreRecycle({ ...req, lineMib: 90, wasmBytes: 87 * MIB }), false, 'just after a login (78 to 87)');
	assert.equal(shouldPreRecycle({ ...req, lineMib: 90, wasmBytes: 24 * MIB }), false, 'a fresh boot');
	assert.equal(shouldPreRecycle({ ...req, lineMib: null, wasmBytes: 120 * MIB }), false, 'off');
	assert.equal(shouldPreRecycle({ lineMib: 90, wasmBytes: 120 * MIB, method: 'GET', pathname: '/wp-json/wp/v2/pages', search: '' }), false, 'REST');
	assert.equal(shouldPreRecycle({ ...req, lineMib: 90, wasmBytes: NaN }), false);
});

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('index.js: the pre-recycle runs before the boot, releases the old runtime, and is measured', () => {
	const at = src.indexOf('const lineMib = preRecycleMib(env);');
	assert.ok(at >= 0, 'the pre-recycle is not wired');
	const booted = src.indexOf('const booted = !bootPromise;', at);
	const boot = src.indexOf('bootPromise ??= boot(origin);', at);
	assert.ok(booted > at && boot > booted, 'it must come before the boot decision');
	const block = src.slice(at, booted);
	assert.match(block, /if \(lineMib && bootPromise\) \{/);
	assert.match(block, /shouldPreRecycle\(\{ lineMib, wasmBytes: oldBytes, method: req\.method, pathname: url\.pathname, search: url\.search \}\)/);
	const nul = block.indexOf('bootPromise = null;');
	const rel = block.indexOf('releaseRuntime(old);');
	assert.ok(nul >= 0 && rel > nul, 'drop the promise, then release the old runtime, before the boot');
	assert.match(block, /console\.log\(JSON\.stringify\(\{ m: 'prerecycle'/, 'logged before the boot, so a killed request still has it in the tail');
	// perf.pre: the missing sample (same isolate, wasm right after the fresh boot).
	assert.match(src, /\.\.\.\(pre \? \{ pre: \{ \.\.\.pre, sameIso: pre\.iso === ISOLATE_ID, bootMiB: Math\.round\(wasm0 \/ 1048576\) \} \} : \{\}\)/);
	assert.match(src, /if \(pre\) out\.set\('x-runtime-prerecycled', String\(pre\.fromMiB\)\);/);
});

test('index.js: with no PRE_RECYCLE_MIB the request path is as before (the line is read, nothing else)', () => {
	// preRecycleMib returns null for an unset var, so the block is skipped whole.
	assert.equal(preRecycleMib({ PHP_RECYCLE: 'off' }), null);
	assert.ok(src.includes("import { preRecycleMib, shouldPreRecycle } from './pre-recycle.mjs';"));
});
