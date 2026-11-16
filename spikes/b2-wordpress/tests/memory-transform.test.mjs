// #598: the prepare.sh memory transform (the module's memory section becomes an env.memory import) with NO reuse:
// every boot gets a new memory of the module's own limits, and a build made BEFORE the transform still runs under
// this loader. node --test tests/memory-transform.test.mjs (after npm ci and ./prepare.sh).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { boot, engineUnderTest, memoryShape, B2 } from './engine-contract.mjs';

const PRIV = createRequire(join(B2, 'package.json'))('@php-wasm/universal').__private__dont__use;

// The engine under test as it was BEFORE the prepare.sh memory transform: the env.memory import (the last import,
// as the transform appends it) removed, and a memory section with the same limits put back in its place in the
// section order (after the table section, before tag/global/export). Same build, same other imports.
function untransform(bytes) {
	const b = Buffer.from(bytes);
	const leb = (i) => { let r = 0, s = 0, x; do { x = b[i++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return [r, i]; };
	const enc = (n) => { const o = []; do { let x = n & 0x7f; n = Math.floor(n / 128); o.push(x | (n ? 0x80 : 0)); } while (n); return Buffer.from(o); };
	const entry = Buffer.concat([enc(3), Buffer.from('env'), enc(6), Buffer.from('memory'), Buffer.from([0x02, 0x01]), enc(384), enc(32768)]);
	const secs = [];
	for (let i = 8; i < b.length;) { const id = b[i]; const [size, j] = leb(i + 1); secs.push([id, b.subarray(j, j + size)]); i = j + size; }
	const out = [b.subarray(0, 8)];
	let lastPre = -1;
	secs.forEach(([id], k) => { if (id >= 1 && id <= 4) lastPre = k; });
	secs.forEach(([id, p], k) => {
		if (id === 5) throw new Error('already defines a memory');
		if (id === 2) {
			assert.ok(p.subarray(p.length - entry.length).equals(entry), 'the last import is not the transform env.memory');
		}
		let q = p;
		if (id === 2) {
			let r = 0, sh = 0, i = 0, x; do { x = p[i++]; r += (x & 0x7f) * 2 ** sh; sh += 7; } while (x & 0x80);
			q = Buffer.concat([enc(r - 1), p.subarray(i, p.length - entry.length)]);
		}
		out.push(Buffer.from([id]), enc(q.length), q);
		if (k === lastPre) { const m = Buffer.concat([enc(1), Buffer.from([0x01]), enc(384), enc(32768)]); out.push(Buffer.from([5]), enc(m.length), m); }
	});
	return Buffer.concat(out);
}

async function answers(e, opts) {
	const { php, exports } = await boot(e, opts);
	const out = (await php.run({ code: '<?php $a = str_repeat("r", 8 * 1048576); echo "ok ", strlen($a);' })).text;
	return { out, buffer: php[PRIV].HEAPU8.buffer, memory: exports.memory };
}

test('each boot of the transformed engine gets a NEW memory of the module limits', async () => {
	const e = engineUnderTest();
	const m = memoryShape(e.bytes);
	assert.deepEqual([m.defined, m.imported && m.imported.min, m.imported && m.imported.max], [null, 384, 32768]);
	const a = await answers(e), b = await answers(e);
	assert.equal(a.out, 'ok 8388608');
	assert.equal(b.out, 'ok 8388608');
	assert.notEqual(a.buffer, b.buffer, 'two boots share a memory without anything handing one in');
	assert.equal(a.memory.buffer, a.buffer, 'the runtime does not use the memory it imported');
});

// The mismatched build: this loader (it would hand a memory in) with the same engine's wasm made BEFORE the
// transform (it defines its own memory). It must keep working and ignore what it is handed: fail safe, no crash.
test('a pre-transform wasm under this loader keeps working and ignores a memory handed to it', async () => {
	const t = engineUnderTest();
	const pre = untransform(t.bytes);
	const m = memoryShape(pre);
	assert.deepEqual([m.defined && m.defined.min, m.imported], [384, null], 'the untransformed wasm does not define its memory');
	const e = { ...t, name: 'mismatch: this loader, pre-transform wasm', bytes: pre, module: new WebAssembly.Module(pre), loaderFile: null };
	const handed = new WebAssembly.Memory({ initial: 384, maximum: 32768 });
	const r = await answers(e, { memory: handed });
	assert.equal(r.out, 'ok 8388608');
	assert.notEqual(r.buffer, handed.buffer, 'a pre-transform wasm used a memory it does not import');
});
