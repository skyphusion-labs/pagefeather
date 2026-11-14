// node --test spikes/b2-wordpress/tests/lazy-write.test.mjs (#530)
// A PHP write to a lazily inflated bundle file must survive the next evict. The test runs the REAL
// code, not a copy: attachLazyContents is cut out of index.js, and MEMFS.write, msync,
// expandFileStorage and resizeFileStorage are cut out of the pinned @php-wasm loader (php_8_3.js),
// then run together. Before the fix, an in-place write (inside usedBytes, no truncate, no growth)
// was lost when drop() ran; that is also measured live on local workerd (PR body).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createArena } from '../inflate-arena.mjs';

const indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
// The same file prepare.sh builds vendor/php_8_3.js from (its exports map hides the subpath).
const loaderSrc = readFileSync(new URL('../node_modules/@php-wasm/web-8-3/jspi/php_8_3.js', import.meta.url), 'utf8');

// The source of one function or method, from its header to its matching closing brace.
function cut(src, header, from = 0) {
	const i = src.indexOf(header, from);
	assert.ok(i >= 0, 'not found: ' + header);
	let depth = 0;
	for (let j = src.indexOf('{', i); j < src.length; j++) {
		if (src[j] === '{') depth++;
		else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
	}
	throw new Error('unbalanced: ' + header);
}

// MEMFS from the loader: the methods this path uses, with a HEAP8 that is never the buffer.
const memfsAt = loaderSrc.indexOf('var MEMFS = {');
assert.ok(memfsAt >= 0, 'the loader has a MEMFS object');
const opsAt = loaderSrc.indexOf('stream_ops: {', loaderSrc.indexOf('ops_table', memfsAt) + 1);
const MEMFS = new Function('HEAP8', `const MEMFS = {
	${cut(loaderSrc, 'expandFileStorage(node, newCapacity) {', memfsAt)},
	${cut(loaderSrc, 'resizeFileStorage(node, newSize) {', memfsAt)},
	stream_ops: {
		${cut(loaderSrc, 'write(stream, buffer, offset, length, position, canOwn) {', memfsAt)},
		${cut(loaderSrc, 'msync(stream, buffer, offset, length, mmapFlags) {', memfsAt)},
	},
}; return MEMFS;`)(new Int8Array(8));

// attachLazyContents from index.js, with its module globals given.
function load(arena) {
	const stats = { reinflates: 0, inflates: 0, inflateBytes: 0, lazyWrites: 0 };
	const drops = [];
	const attach = new Function('stats', 'tracing', 'fileTrace', 'arenaOn', 'getArena', 'noteInflated',
		cut(indexSrc, 'function attachLazyContents(node, size, dataFn, tag) {') + '\nreturn attachLazyContents;')(
		stats, () => false, null, () => !!arena, () => arena, (drop) => drops.push(drop));
	return { stats, drops, attach };
}
const A = new TextEncoder().encode('A'.repeat(64));
function lazyNode(env, bytes = A) {
	const node = { stream_ops: MEMFS.stream_ops };
	env.attach(node, bytes.length, (out) => {
		const v = out ? out(bytes.length) : null;
		if (v) { v.set(bytes); return v; }
		return bytes.slice();
	});
	const stream = { node, stream_ops: node.stream_ops }; // FS.open copies node.stream_ops
	const dropAll = () => { for (const d of env.drops) d(); if (env.arena) env.arena.evictAll(); };
	return { node, stream, dropAll };
}
const text = (node) => new TextDecoder().decode(node.contents.subarray(0, node.usedBytes));
const B = (n) => new TextEncoder().encode('B'.repeat(n));

for (const arenaOn of [false, true]) {
	const label = arenaOn ? 'arena on' : 'arena off';
	test(`#530 ${label}: a same-length in-place write survives the evict`, () => {
		const arena = arenaOn ? createArena(2 * 1048576) : null;
		const e2 = load(arena); e2.arena = arena;
		const f = lazyNode(e2);
		assert.equal(text(f.node), 'A'.repeat(64), 'inflated');
		f.stream.stream_ops.write(f.stream, B(64), 0, 64, 0, false);
		assert.equal(text(f.node), 'B'.repeat(64), 'written in the request');
		f.dropAll();
		assert.equal(text(f.node), 'B'.repeat(64), 'still written after the evict');
		assert.equal(e2.stats.lazyWrites, 1);
	});
	test(`#530 ${label}: a shorter overwrite inside the file survives the evict`, () => {
		const arena = arenaOn ? createArena(2 * 1048576) : null;
		const e2 = load(arena); e2.arena = arena;
		const f = lazyNode(e2);
		f.stream.stream_ops.write(f.stream, B(3), 0, 3, 10, false);
		f.dropAll();
		assert.equal(text(f.node), 'A'.repeat(10) + 'BBB' + 'A'.repeat(51));
	});
	test(`#530 ${label}: a growing write and an msync are kept too`, () => {
		const e = load(null); const f = lazyNode(e);
		f.stream.stream_ops.write(f.stream, B(80), 0, 80, 0, false);
		f.dropAll();
		assert.equal(text(f.node), 'B'.repeat(80));
		const g = lazyNode(e);
		g.stream.stream_ops.msync(g.stream, B(64), 0, 64, 0);
		g.dropAll();
		assert.equal(text(g.node), 'B'.repeat(64));
	});
}
test('#530 arena on: a written file holds a private copy, so ring reuse cannot overwrite it', () => {
	const arena = createArena(256);
	const e = load(arena); e.arena = arena;
	const f = lazyNode(e);
	f.stream.stream_ops.write(f.stream, B(64), 0, 64, 0, false);
	// Fill the whole ring with other files: every region is reused, and every live entry evicted.
	for (let k = 0; k < 8; k++) { const o = lazyNode(e, new TextEncoder().encode(String(k).repeat(64))); void o.node.contents; }
	assert.equal(text(f.node), 'B'.repeat(64));
});
test('#530 an unwritten file is still dropped and re-inflated (the memory win stays)', () => {
	const e = load(null);
	const f = lazyNode(e);
	void f.node.contents;
	f.dropAll();
	void f.node.contents;
	assert.equal(e.stats.reinflates, 1);
	assert.equal(e.stats.lazyWrites, 0);
});
