// node --test spikes/b2-wordpress/tests/mem-ledger.test.mjs (#394, the isolate memory ledger)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLedger, memfsBytes, createSqlMeter, ledgerOn } from '../mem-ledger.mjs';

const MIB = 1048576;
// A small Emscripten-shaped FS: directories hold {name: node}; files hold a Uint8Array.
const DIR = 0o040000, FILE = 0o100000;
function fakeFs() {
	const file = (n) => ({ mode: FILE, contents: new Uint8Array(n) });
	const lazy = () => {
		const n = { mode: FILE };
		Object.defineProperty(n, 'contents', { configurable: true, get() { throw new Error('the ledger inflated a lazy file'); } });
		return n;
	};
	const tmp = { mode: DIR, contents: { a: file(3 * MIB), b: file(MIB) } };
	const internal = { mode: DIR, contents: { opcache: { mode: DIR, contents: { x: file(2 * MIB) } } } };
	const wp = { mode: DIR, contents: { 'index.php': lazy(), 'wp-load.php': lazy() } };
	const root = { mode: DIR, contents: { tmp, internal, wordpress: wp } };
	return { root, isDir: (m) => (m & 0o170000) === DIR };
}

test('memfsBytes: sums written files by top directory and never reads a lazy file', () => {
	const r = memfsBytes(fakeFs());
	assert.equal(r.totalMiB, 6);
	assert.equal(r.files, 3);
	assert.equal(r.lazySkipped, 2);
	assert.deepEqual(r.byTop, { '/tmp': 4, '/internal': 2 });
	assert.equal(r.truncated, false);
});

test('memfsBytes: bounded, and safe on a missing FS', () => {
	assert.equal(memfsBytes(fakeFs(), 3).truncated, true);
	assert.equal(memfsBytes(null).totalMiB, 0);
});

test('ledger.runtimes: the current runtime apart, every other live one is retired, with its bytes', () => {
	const l = createLedger();
	const heaps = new Map();
	const mk = (bytes) => { const p = {}; heaps.set(p, bytes); return p; };
	const a = mk(97 * MIB), b = mk(24 * MIB);
	l.register(a, 1);
	l.register(b, 2);
	const r = l.runtimes(2, (p) => heaps.get(p));
	assert.equal(r.booted, 2);
	assert.equal(r.live, 2);
	assert.equal(r.retired, 1);
	assert.equal(r.retiredMiB, 97);
	assert.equal(r.currentMiB, 24);
	assert.equal(r.finalizer, typeof FinalizationRegistry === 'function');
});

test('sqlMeter and ledgerOn', () => {
	const s = createSqlMeter();
	s.add(1024); s.add(3 * MIB);
	assert.deepEqual(s.read(), { n: 2, MiB: 3, maxKiB: 3072 });
	s.reset();
	assert.deepEqual(s.read(), { n: 0, MiB: 0, maxKiB: 0 });
	assert.equal(ledgerOn({}, '1', false), false, 'a visitor header does nothing');
	assert.equal(ledgerOn({}, '1', true), true, 'an operator request');
	assert.equal(ledgerOn({}, null, true), false, 'off by default');
	assert.equal(ledgerOn({ MEM_LEDGER: 'on' }, null, false), true);
	assert.equal(ledgerOn({ MEM_LEDGER: 'yes' }, null, false), false);
});

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('index.js: off by default, per request, and snapshots at the memory-limit SQL write, write-loss and end', () => {
	assert.match(src, /ledgerActive = ledgerOn\(env, req\.headers\.get\('x-mem-ledger'\), perfHeadersAllowed\(req, env\)\);/);
	assert.match(src, /ledger\.register\(php, runtimeSerial\);/);
	const sql = src.indexOf('const reply = sqlStatement(sqlDb, m);');
	const blk = src.slice(sql, src.indexOf('return out;', sql));
	assert.match(blk, /if \(ledgerActive\) \{/);
	assert.match(blk, /MEMORY_RESET\.test\(String\(reply\.error \|\| ''\)\) && !ledgerFailLogged/);
	assert.match(blk, /ledgerLog\('sql-memory-fail'/);
	assert.match(src, /if \(lost\) \{\s*if \(ledgerActive\) ledgerLog\('write-loss'/);
	assert.match(src, /\.\.\.\(ledgerActive \? \{ mem: ledgerSnapshot\('end'\) \} : \{\}\)/);
	assert.match(src, /ledgerActive = this\.env\.MEM_LEDGER === 'on';/);
});
