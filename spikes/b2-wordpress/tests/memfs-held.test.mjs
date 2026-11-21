// node --test spikes/b2-wordpress/tests/memfs-held.test.mjs (#1022)
// fsKiB on the perf line: the bytes the runtime's MEMFS file nodes hold on the JS side, outside the wasm heap.
// The isolate budget (about 255 MiB, #394 floor probes) is shared by the wasm heap and every ArrayBuffer, and
// a death at wasm 102 left about 100 MiB unexplained (#1022). This counts one measured part of it.
// The reading must change nothing: the walk never inflates a lazy file (the real attachLazyContents from
// index.js is used, not a copy), never materialises a lazy directory child (it reads node.contents, not
// lookup), counts each ArrayBuffer once (a stored file is a view of the bundle zip; arena entries share
// the arena), and leaves out the bundle's own buffers (a fixed cost, measured once in #394).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { memfsHeld, fsSampleWhy, FS_SAMPLE_EVERY } from '../memfs-held.mjs';

const indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
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
function loadAttach() {
	const stats = { reinflates: 0, inflates: 0, inflateBytes: 0, lazyWrites: 0 };
	const attach = new Function('stats', 'tracing', 'fileTrace', 'arenaOn', 'getArena', 'noteInflated',
		cut(indexSrc, 'function attachLazyContents(node, size, dataFn, tag) {') + '\nreturn attachLazyContents;')(
		stats, () => false, null, () => false, () => null, (drop, n) => { stats.inflates++; stats.inflateBytes += n; });
	return { stats, attach };
}
const DIR = 0o040755, FILE = 0o100644, LINK = 0o120777;
const dir = (contents = {}) => ({ mode: DIR, contents });
const file = (bytes) => ({ mode: FILE, contents: bytes, usedBytes: bytes ? bytes.length : 0 });

test('#1022 a plain MEMFS file counts its bytes; an empty one counts none', () => {
	const root = dir({ a: file(new Uint8Array(3072)), b: file(null) });
	assert.deepEqual(memfsHeld(root), { bytes: 3072, files: 1, buffers: 1 });
});
test('#1022 two views of one buffer count once (a stored file is a view of the bundle)', () => {
	const buf = new ArrayBuffer(8192);
	const root = dir({ a: file(new Uint8Array(buf, 0, 100)), b: file(new Uint8Array(buf, 100, 200)) });
	assert.deepEqual(memfsHeld(root), { bytes: 8192, files: 2, buffers: 1 });
});
test('#1022 the bundle zip buffers are left out (a fixed cost)', () => {
	const zip = new Uint8Array(1 << 20);
	const root = dir({ stored: file(zip.subarray(10, 500)), own: file(new Uint8Array(1000)) });
	assert.deepEqual(memfsHeld(root, [zip]), { bytes: 1000, files: 1, buffers: 1 });
});
test('#1022 a lazy file is NEVER inflated by the walk, and counts only what it holds', () => {
	const env = loadAttach();
	let made = 0;
	const node = { mode: FILE };
	env.attach(node, 4096, () => { made++; return new Uint8Array(4096); });
	const root = dir({ lazy: node });
	assert.deepEqual(memfsHeld(root), { bytes: 0, files: 0, buffers: 0 }, 'not yet read: holds nothing');
	assert.equal(made, 0, 'the walk did not inflate it');
	assert.equal(env.stats.inflates, 0);
	assert.equal(node.contents.length, 4096, 'a real read inflates');
	assert.equal(made, 1);
	assert.deepEqual(memfsHeld(root), { bytes: 4096, files: 1, buffers: 1 }, 'after the read it holds the copy');
	assert.equal(made, 1, 'and the second walk did not inflate again');
});
test('#1022 a node with a contents getter and NO pfHeld is never read (reading it could inflate)', () => {
	let reads = 0;
	const node = { mode: FILE };
	Object.defineProperty(node, 'contents', { configurable: true, get() { reads++; return new Uint8Array(64); } });
	assert.deepEqual(memfsHeld(dir({ g: node })), { bytes: 0, files: 0, buffers: 0 });
	assert.equal(reads, 0);
});
test('#1022 a lazy directory child that was never looked up is not created by the walk', () => {
	const d = dir({});
	d.lazyIndex = { children: { never: {} } };
	const root = dir({ wp: d });
	memfsHeld(root);
	assert.deepEqual(Object.keys(d.contents), [], 'the walk read node.contents only');
});
test('#1022 a mounted subtree is walked; a symlink and a cycle are safe', () => {
	const inner = dir({ x: file(new Uint8Array(500)) });
	const mnt = dir({});
	mnt.mounted = { root: inner };
	const root = dir({ m: mnt, l: { mode: LINK, link: '/m/x' } });
	root.contents.self = root;
	assert.deepEqual(memfsHeld(root), { bytes: 500, files: 1, buffers: 1 });
});
// The walk costs about 1 ms per request at about 10,300 nodes (a WooCommerce site), so it is sampled (lead review):
// a boot request, every FS_SAMPLE_EVERY-th request of a runtime, and any request at or above the recycle line.
const MiB = 1048576;
test('#1022 the sample rule: boot, every 20th, at or above the line; nothing between', () => {
	assert.equal(FS_SAMPLE_EVERY, 20);
	const line = 140 * MiB;
	assert.equal(fsSampleWhy({ boot: true, served: 1, wasmBytes: 80 * MiB, lineBytes: line }), 'boot');
	assert.equal(fsSampleWhy({ boot: false, served: 20, wasmBytes: 90 * MiB, lineBytes: line }), 'nth');
	assert.equal(fsSampleWhy({ boot: false, served: 40, wasmBytes: 90 * MiB, lineBytes: line }), 'nth');
	assert.equal(fsSampleWhy({ boot: false, served: 7, wasmBytes: 140 * MiB, lineBytes: line }), 'line');
	assert.equal(fsSampleWhy({ boot: false, served: 7, wasmBytes: 150 * MiB, lineBytes: line }), 'line');
	for (const served of [2, 3, 19, 21, 39]) {
		assert.equal(fsSampleWhy({ boot: false, served, wasmBytes: 139 * MiB, lineBytes: line }), null, 'a request between samples: ' + served);
	}
	assert.equal(fsSampleWhy({ boot: false, served: 5, wasmBytes: 139 * MiB, lineBytes: 0 }), null, 'no line set: only boot and nth');
	assert.equal(fsSampleWhy({ boot: false, served: 5, wasmBytes: 139 * MiB }), null);
});
test('#1022 index.js wires it: lazy nodes expose pfHeld, and the perf line carries fsKiB from memfsHeld', () => {
	assert.match(cut(indexSrc, 'function attachLazyContents(node, size, dataFn, tag) {'), /pfHeld/);
	assert.match(indexSrc, /fsKiB: Math\.round\(fsHeld\.bytes \/ 1024\)/);
	assert.match(indexSrc, /memfsHeld\(FS\.root, BUNDLE_BUFFERS\)/);
	assert.match(indexSrc, /fsWhy = fsSampleWhy\(\{ boot: booted, served: runtimeServed, wasmBytes, lineBytes: line\.bytes \}\)/);
	assert.match(indexSrc, /if \(fsWhy\) \{/, 'the walk runs only when the rule says so');
	assert.match(indexSrc, /fsWhy, fsKiB: Math\.round/, 'the perf line says why this request carries fsKiB');
});
