// node --test spikes/b2-wordpress/tests/opcache-compiled.test.mjs (#1253)
// opCompiled on the approach A perf line: the scripts a request COMPILED from source. An OPcache miss is not a
// compile (the file cache, from the packs, satisfies most); only a compile WRITES a .bin into the file cache. So:
// new plain files under the file-cache directory (a script the packs lack), plus rewrites of packed .bin nodes (the
// lazy write path, tag opcache: a packed script recompiled). Counted on boot requests (#1169 issuecomment-7065037907),
// and when an operator sends x-perf-opcache: 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plainFileCount } from '../opcache-compiled.mjs';
import { aPerfLine } from '../perf-line.mjs';

const DIR = 0o040755, FILE = 0o100644;
const dir = (contents = {}) => ({ mode: DIR, contents });
const plain = (n = 10) => ({ mode: FILE, contents: new Uint8Array(n) });
function lazy() { const node = { mode: FILE }; Object.defineProperty(node, 'contents', { configurable: true, get() { throw new Error('read a lazy node'); } }); return node; }

test('#1253 plainFileCount counts plain files (written by PHP) and never reads a lazy node', () => {
	const sub = dir({ 'a.php.bin': plain(), 'b.php.bin': lazy(), deep: dir({ 'c.php.bin': plain(), 'd.php.bin': lazy() }) });
	assert.equal(plainFileCount(sub), 2);
	assert.equal(plainFileCount(dir()), 0);
	assert.equal(plainFileCount(null), 0);
	const cyc = dir({ x: plain() }); cyc.contents.self = cyc;
	assert.equal(plainFileCount(cyc), 1, 'a cycle terminates');
});
test('#1253 aPerfLine carries opCompiled when given, and omits it otherwise', () => {
	assert.equal(aPerfLine({ path: '/', opCompiled: 37, opHits: 5, opMisses: 40 }).opCompiled, 37);
	assert.equal('opCompiled' in aPerfLine({ path: '/' }), false);
});
test('#1253 index.js: counters on a boot (or the operator header); a packed .bin rewrite counts; the delta reaches the line', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /const wantOpcache = booted \|\| \(spikeOk && req\.headers\.get\('x-perf-opcache'\) === '1'\);/);
	const own = src.slice(src.indexOf('function attachLazyContents(node, size, dataFn, tag) {'));
	assert.match(own.slice(0, own.indexOf('\n}\n')), /if \(tag && tag\.src === 'opcache'\) stats\.opRewrites\+\+;/);
	assert.match(src, /opCompiled: op0\.plain === null \|\| op1\.plain === null \? undefined : op1\.plain - op0\.plain \+ \(op1\.rewrites - op0\.rewrites\)/);
});
