// node --test spikes/b2-wordpress/tests/allocator-reading.test.mjs (issue #547). Needs npm ci and
// ./prepare.sh in spikes/b2-wordpress (vendor/php_8_3.js, vendor/php_8_3.wasm).
//
// /_memprobe (index.js) and the memory trace (php/mem-trace.php, #434) say which allocator PHP
// runs. getenv('USE_ZEND_ALLOC') cannot say it: php-wasm sets USE_ZEND_ALLOC=0 itself after Zend's
// memory manager has read it, so getenv reads "0" with either setting (measured: the wasm holds the
// string "USE_ZEND_ALLOC=0"). The live heap can: memory_get_usage(true) is 0 when Zend's allocator
// is off. This test takes each file's expression and runs it in the real loader, booted both ways.
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
const { loadPHPRuntime, PHP } = require('@php-wasm/universal');

const index = readFileSync(join(B2, 'index.js'), 'utf8');
const trace = readFileSync(join(B2, 'php/mem-trace.php'), 'utf8');
// The PHP expression after the key, up to the comma or the closing parenthesis of the array.
function expr(src, key) {
	const m = src.match(new RegExp("'" + key + "'\\s*=>\\s*(.+?)\\s*(?:,\\s*$|\\);)", 'm'));
	assert.ok(m, 'no ' + key + ' field');
	return m[1];
}
const READERS = { 'index.js /_memprobe use_zend_alloc': expr(index, 'use_zend_alloc'), 'mem-trace.php zend': expr(trace, 'zend') };

const dir = mkdtempSync(join(tmpdir(), 'alloc547-'));
writeFileSync(join(dir, 'loader.mjs'), readFileSync(join(B2, 'vendor/php_8_3.js')));
const wasm = new WebAssembly.Module(readFileSync(join(B2, 'vendor/php_8_3.wasm')));
async function run(zend, code) {
	const loader = await import(join(dir, 'loader.mjs') + '?z=' + zend + '&c=' + encodeURIComponent(code));
	const id = await loadPHPRuntime(loader, {
		ENV: { USE_ZEND_ALLOC: zend },
		instantiateWasm(imports, done) { const inst = new WebAssembly.Instance(wasm, imports); done(inst, wasm); return inst.exports; },
	});
	const r = await new PHP(id).run({ code: '<?php $a = str_repeat("x", 3000000); echo json_encode(' + code + ');' });
	assert.equal(r.errors, '', 'PHP errors: ' + r.errors);
	return JSON.parse(r.text);
}

test('control: getenv reads "0" with either setting, so it cannot be the reading', async () => {
	assert.deepEqual([await run('0', "getenv('USE_ZEND_ALLOC')"), await run('1', "getenv('USE_ZEND_ALLOC')")], ['0', '0']);
	assert.deepEqual([await run('0', 'memory_get_usage(true)') === 0, await run('1', 'memory_get_usage(true)') > 0], [true, true], 'the live heap tells them apart');
});

for (const [name, code] of Object.entries(READERS)) {
	test(name + ' reads "0" with the allocator off and "1" with it on', async () => {
		assert.doesNotMatch(code, /getenv/, name + ' must not read getenv: ' + code);
		assert.deepEqual([await run('0', code), await run('1', code)], ['0', '1'], name + ': ' + code);
	});
}

test.after(() => rmSync(dir, { recursive: true, force: true }));
