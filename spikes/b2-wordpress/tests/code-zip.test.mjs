// node --test spikes/b2-wordpress/tests/code-zip.test.mjs (#449). Needs the spike's node_modules (fflate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { zipStream } from '../code-zip.mjs';

function* tree(spec, log) {
	for (const [name, bytes] of spec) {
		yield {
			name,
			read() {
				log.push(name);
				return bytes;
			},
		};
	}
}

test('a tree round-trips: the zip unzips to exactly the files, bytes unchanged', () => {
	const spec = [
		['plugin.php', new TextEncoder().encode('<?php /* Plugin Name: x */')],
		['inc/a.php', new Uint8Array(5000).fill(65)],
		['assets/b.bin', Uint8Array.from({ length: 3000 }, (_, i) => (i * 7) & 255)],
	];
	const { zip, raw, files } = zipStream(tree(spec, []));
	assert.equal(files, 3);
	assert.equal(raw, spec.reduce((n, [, b]) => n + b.length, 0));
	const out = unzipSync(zip);
	assert.deepEqual(Object.keys(out).sort(), spec.map(([n]) => n).sort());
	for (const [n, b] of spec) assert.deepEqual([...out[n]], [...b], n);
});

test('the size cap refuses before reading the rest: no further file is read', () => {
	const log = [];
	const spec = [
		['a', new Uint8Array(600)],
		['b', new Uint8Array(600)],
		['c', new Uint8Array(600)],
	];
	assert.throws(() => zipStream(tree(spec, log), { maxRaw: 1000 }), /larger than/);
	assert.deepEqual(log, ['a', 'b'], 'c is never read');
});

test('files are read one at a time, in order, each once', () => {
	const log = [];
	const spec = Array.from({ length: 20 }, (_, i) => ['f' + i, new Uint8Array(100).fill(i)]);
	zipStream(tree(spec, log));
	assert.deepEqual(log, spec.map(([n]) => n));
});

test('an empty tree gives a valid empty zip', () => {
	const { zip, files } = zipStream([]);
	assert.equal(files, 0);
	assert.deepEqual(Object.keys(unzipSync(zip)), []);
});
