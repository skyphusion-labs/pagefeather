// node --test spikes/b2-wordpress/tests/recycle-line.test.mjs (#598). The runtime recycle decision, out of
// index.js into recycle-line.mjs so it can be tested. Today a runtime whose WebAssembly memory passed 100
// MiB is dropped after its request. On pf582t (the lean engine, #582) editor pages end at 109 to 114 MiB:
// over that line, but under the point where Workers replaces the isolate, so the dropped memory stayed in
// the isolate and the next boot stacked a second one (20 of 70 died). RECYCLE_WASM_MIB moves the line; its
// default stays 100 until a measured window sets it (the lead's ruling, #598).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECYCLE_DEFAULT_MIB, recycleLine, recycleDecision } from '../recycle-line.mjs';

const MiB = 1048576;

test('the default line is today\'s 100 MiB, unset or empty', () => {
	assert.equal(RECYCLE_DEFAULT_MIB, 100);
	for (const env of [{}, { RECYCLE_WASM_MIB: '' }, undefined]) {
		assert.deepEqual(recycleLine(env), { bytes: 100 * MiB, mib: 100, source: 'default' });
	}
});

test('RECYCLE_WASM_MIB sets the line, an integer from 64 to 240 MiB', () => {
	assert.deepEqual(recycleLine({ RECYCLE_WASM_MIB: '130' }), { bytes: 130 * MiB, mib: 130, source: 'RECYCLE_WASM_MIB' });
	assert.equal(recycleLine({ RECYCLE_WASM_MIB: '64' }).mib, 64);
	assert.equal(recycleLine({ RECYCLE_WASM_MIB: '240' }).mib, 240);
});

test('a bad RECYCLE_WASM_MIB keeps the default and says why, never a line of 0 or NaN', () => {
	for (const v of ['0', '63', '241', '12.5', 'abc', '-100', '1e3', ' 130']) {
		const l = recycleLine({ RECYCLE_WASM_MIB: v });
		assert.equal(l.mib, 100, v);
		assert.equal(l.source, 'default');
		assert.match(l.refused, /RECYCLE_WASM_MIB/, v);
	}
});

test('a heap between 100 MiB and the line is KEPT (the pf582t band), over the line it is recycled', () => {
	const line = recycleLine({ RECYCLE_WASM_MIB: '130' }).bytes;
	assert.equal(recycleDecision({ wasmBytes: 114 * MiB, lineBytes: line }), null, 'an editor page at 114 MiB keeps its runtime');
	assert.equal(recycleDecision({ wasmBytes: 131 * MiB, lineBytes: line }), 'memory');
	// today's rule, the line at 100: the same 114 MiB heap is recycled (what pf582t did)
	assert.equal(recycleDecision({ wasmBytes: 114 * MiB, lineBytes: recycleLine({}).bytes }), 'memory');
});

test('#603 (A): a memory recycle needs THIS runtime to have grown past the line, not an inherited size', () => {
	const line = 64 * MiB;
	// a runtime that booted on a reused 82 MiB memory and grew nothing: no recycle (the loop)
	assert.equal(recycleDecision({ wasmBytes: 82 * MiB, lineBytes: line, bootBytes: 82 * MiB }), null, 'an inherited size recycles every request');
	// it grew past what it inherited, and past the line: recycle
	assert.equal(recycleDecision({ wasmBytes: 90 * MiB, lineBytes: line, bootBytes: 82 * MiB }), 'memory');
	// grew, but stays under the line: no recycle
	assert.equal(recycleDecision({ wasmBytes: 60 * MiB, lineBytes: line, bootBytes: 24 * MiB }), null);
	// no reuse: it booted at the 24 MiB start, so the rule is today's
	assert.equal(recycleDecision({ wasmBytes: 65 * MiB, lineBytes: line, bootBytes: 24 * MiB }), 'memory');
	assert.equal(recycleDecision({ wasmBytes: 65 * MiB, lineBytes: line }), 'memory', 'without bootBytes, today');
});

test('the heap AT the line is kept: only a heap over it is recycled (as index.js compared, >)', () => {
	assert.equal(recycleDecision({ wasmBytes: 100 * MiB, lineBytes: 100 * MiB }), null);
	assert.equal(recycleDecision({ wasmBytes: 100 * MiB + 1, lineBytes: 100 * MiB }), 'memory');
});

test('a crashed runtime is always dropped, a forced recycle too; PHP_RECYCLE=off stops only the memory recycle', () => {
	const small = { wasmBytes: 40 * MiB, lineBytes: 100 * MiB };
	assert.equal(recycleDecision({ ...small, crashed: true }), 'crashed');
	assert.equal(recycleDecision({ ...small, crashed: true, recycleOff: true }), 'crashed');
	assert.equal(recycleDecision({ ...small, forced: true }), 'forced');
	assert.equal(recycleDecision({ wasmBytes: 200 * MiB, lineBytes: 100 * MiB, recycleOff: true }), null);
	assert.equal(recycleDecision({ wasmBytes: 200 * MiB, lineBytes: 100 * MiB, recycleOff: true, forced: true }), 'forced');
});

test('#771: the engine passes its own default line (140 lean, 100 npm); an explicit RECYCLE_WASM_MIB still wins', () => {
	assert.deepEqual(recycleLine({}, 140), { bytes: 140 * MiB, mib: 140, source: 'default' }, 'lean, unset: 140');
	assert.deepEqual(recycleLine({}, 100), { bytes: 100 * MiB, mib: 100, source: 'default' }, 'npm, unset: 100');
	assert.deepEqual(recycleLine({ RECYCLE_WASM_MIB: '110' }, 140), { bytes: 110 * MiB, mib: 110, source: 'RECYCLE_WASM_MIB' }, 'the site setting wins');
	const bad = recycleLine({ RECYCLE_WASM_MIB: 'lots' }, 140);
	assert.equal(bad.mib, 140, 'a bad value keeps the ENGINE default, not 100');
	assert.ok(bad.refused, 'and says why');
	assert.equal(recycleLine({}, 'x').mib, RECYCLE_DEFAULT_MIB, 'a malformed default falls back to the constant');
	assert.equal(recycleLine({}, 500).mib, RECYCLE_DEFAULT_MIB, 'an out-of-range default too');
});
