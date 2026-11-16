// #598: the prepare.sh memory transform (the module's memory section becomes an env.memory import) with NO reuse:
// every boot gets a new memory of the module's own limits, and a build made BEFORE the transform still runs under
// this loader. node --test tests/memory-transform.test.mjs (after npm ci and ./prepare.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { boot, engineUnderTest, memoryShape, B2 } from './engine-contract.mjs';
import { untransformMemory } from '../../../engine/tools/wasm-sections.mjs';

const PRIV = createRequire(join(B2, 'package.json'))('@php-wasm/universal').__private__dont__use;


async function answers(e) {
	const { php, exports } = await boot(e);
	const out = (await php.run({ code: '<?php $a = str_repeat("r", 8 * 1048576); echo "ok ", strlen($a);' })).text;
	return { out, buffer: php[PRIV].HEAPU8.buffer, memory: exports.memory };
}

test('each boot of the transformed engine gets a NEW memory of the module limits', async () => {
	const e = engineUnderTest();
	const m = memoryShape(e.bytes);
	assert.deepEqual([m.defined, m.imported && m.imported.min], [null, e.expect.initialPages]);
	const a = await answers(e), b = await answers(e);
	assert.equal(a.out, 'ok 8388608');
	assert.equal(b.out, 'ok 8388608');
	assert.notEqual(a.buffer, b.buffer, 'two boots share a memory without anything handing one in');
	assert.equal(a.memory.buffer, a.buffer, 'the runtime does not use the memory it imported');
});

// The mismatched build: this loader (it builds an env.memory) with the same engine's wasm made BEFORE the transform
// (it defines its own memory). It must keep working, on its own memory: fail safe, no crash.
test('a pre-transform wasm under this loader keeps working on its own memory', async () => {
	const t = engineUnderTest();
	const pre = untransformMemory(t.bytes);
	const m = memoryShape(pre);
	assert.deepEqual([m.defined && m.defined.min, m.imported], [t.expect.initialPages, null], 'the untransformed wasm does not define its memory');
	const e = { ...t, name: 'mismatch: this loader, pre-transform wasm', bytes: pre, module: new WebAssembly.Module(pre), loaderFile: null };
	const r = await answers(e);
	assert.equal(r.out, 'ok 8388608');
	assert.equal(r.memory.buffer, r.buffer, 'the pre-transform runtime is not on its own memory');
});
