// node --test spikes/b2-wordpress/tests/heap-subarray.test.mjs (issue #518). Needs npm ci and
// ./prepare.sh in spikes/b2-wordpress (vendor/php_8_3.js, vendor/php_8_3.wasm).
//
// In production workerd an ArrayBuffer is at most 128 MiB (2^27 bytes, measured 2026-11-14 on a
// workers.dev probe), and %TypedArray%.prototype.subarray refuses a begin offset above it with
// "RangeError: Invalid array buffer length" (V8 typed-array-subarray.tq, step 17). The wasm heap
// grows past 128 MiB, so a heap read there failed: js_module_onMessage's UTF8ToString, wp/v2 REST
// 500 with USE_ZEND_ALLOC=1. Locally the limit is 2^53-1, so this test INJECTS a 1 MiB limit with
// the same rule. PHP's strings sit above 1 MiB (its static data ends at 12.4 MiB), so the
// injected limit is in the path of every message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const B2 = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(B2, 'package.json'));
globalThis.require ??= require; // the loader takes the node path in node and calls require
const { loadPHPRuntime, PHP, __private__dont__use } = require('@php-wasm/universal');
const LIMIT = 1048576;
const FIX = "		// Pagefeather (#518): a subarray past the 128 MiB ArrayBuffer limit of workerd.\n";

const TA = Object.getPrototypeOf(Uint8Array.prototype);
const nativeSubarray = TA.subarray;
// V8's step 17 with LIMIT in place of ArrayBufferMaxByteLength(): the clamped begin index, past
// the limit in elements, throws. Everything else is the native subarray.
function limitedSubarray(begin, end) {
	const len = this.length;
	let b = begin === undefined ? 0 : Math.trunc(Number(begin)) || 0;
	b = b < 0 ? Math.max(len + b, 0) : Math.min(b, len);
	if (b > LIMIT / this.BYTES_PER_ELEMENT) throw new RangeError('Invalid array buffer length');
	return nativeSubarray.call(this, begin, end);
}

const dir = mkdtempSync(join(tmpdir(), 'heap518-'));
const src = readFileSync(join(B2, 'vendor/php_8_3.js'), 'utf8');
const wasm = new WebAssembly.Module(readFileSync(join(B2, 'vendor/php_8_3.wasm')));
writeFileSync(join(dir, 'fixed.mjs'), src);
writeFileSync(join(dir, 'stock.mjs'), src.split(FIX).join(FIX + '		if (false)\n'));

async function boot(file) {
	const loader = await import(join(dir, file));
	const id = await loadPHPRuntime(loader, {
		ENV: { USE_ZEND_ALLOC: '1' },
		instantiateWasm(imports, done) { const inst = new WebAssembly.Instance(wasm, imports); done(inst, wasm); return inst.exports; },
	});
	return new PHP(id);
}

// One message of 300 bytes from PHP; the Worker answers with 4000 bytes. Returns what each side saw.
async function roundTrip(php) {
	const seen = [];
	php.onMessage(async (raw) => { seen.push(raw); return JSON.stringify({ ok: true, pad: 'r'.repeat(4000) }); });
	const msg = JSON.stringify({ probe: 'm'.repeat(300) });
	let out = null, error = null;
	try {
		const r = await php.run({ code: `<?php $r = post_message_to_js(${JSON.stringify(msg)}); echo is_string($r) ? strlen($r) : var_export($r, true);` });
		out = r.text;
	} catch (e) { error = String(e && e.message || e); }
	return { msg, seen, out, error };
}

test('the fix is in the built loader (prepare.sh applied it)', () => {
	assert.equal(src.split(FIX).length, 2, 'vendor/php_8_3.js has the #518 patch once: run ./prepare.sh');
	assert.ok(readFileSync(join(dir, 'stock.mjs'), 'utf8').includes(FIX + '		if (false)\n'), 'the stock copy disables it');
});

test('control: the injected limit refuses a subarray past it, as production V8 does', () => {
	TA.subarray = limitedSubarray;
	try {
		const h = new Uint8Array(new WebAssembly.Memory({ initial: 32 }).buffer); // 2 MiB
		assert.throws(() => h.subarray(LIMIT + 16, LIMIT + 48), /Invalid array buffer length/);
		assert.equal(h.subarray(LIMIT - 64, LIMIT - 32).length, 32);
	} finally { TA.subarray = nativeSubarray; }
});

test('the heap subarray matches the native one, past the limit too', async () => {
	const php = await boot('fixed.mjs');
	const h = php[__private__dont__use].HEAPU8;
	assert.ok(h.length > 16 * LIMIT, 'heap ' + h.length);
	assert.ok(Object.hasOwn(h, 'subarray'), 'HEAPU8 has its own subarray');
	const n = h.length;
	const cases = [[], [5], [5, 40], [-40], [-40, -8], [40, 5], [n + 9], [0, n + 9], [NaN, 12], [2.9, 7.9], [-Infinity, Infinity], [3 * LIMIT, 3 * LIMIT + 77], [n - 3, n]];
	for (const c of cases) {
		const mine = h.subarray(...c), theirs = nativeSubarray.apply(h, c);
		assert.equal(mine.byteOffset, theirs.byteOffset, 'byteOffset ' + JSON.stringify(c));
		assert.equal(mine.length, theirs.length, 'length ' + JSON.stringify(c));
		assert.equal(mine.buffer, h.buffer, 'same buffer ' + JSON.stringify(c));
	}
	const h32 = php[__private__dont__use].HEAPU32;
	assert.deepEqual([h32.subarray(LIMIT, LIMIT + 4).byteOffset, h32.subarray(-2).length], [4 * LIMIT, 2]);
	TA.subarray = limitedSubarray;
	try {
		assert.equal(h.subarray(3 * LIMIT, 3 * LIMIT + 77).length, 77, 'past the injected limit');
	} finally { TA.subarray = nativeSubarray; }
});

test('stock loader: a message read past the limit fails (the #518 defect)', async () => {
	const php = await boot('stock.mjs');
	TA.subarray = limitedSubarray;
	let r;
	try { r = await roundTrip(php); } finally { TA.subarray = nativeSubarray; }
	assert.deepEqual({ seen: r.seen.length, error: r.error }, { seen: 0, error: 'Invalid array buffer length' }, 'the stock loader must fail as production did; if it delivers, the injected limit is not in its path');
});

test('fixed loader: the message and the answer cross past the limit', async () => {
	const php = await boot('fixed.mjs');
	TA.subarray = limitedSubarray;
	let r;
	try { r = await roundTrip(php); } finally { TA.subarray = nativeSubarray; }
	assert.equal(r.error, null);
	assert.deepEqual(r.seen, [r.msg]);
	assert.equal(r.out, String(JSON.stringify({ ok: true, pad: 'r'.repeat(4000) }).length));
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
