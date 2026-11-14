// node --test spikes/b2-wordpress/tests/mem-ledger.test.mjs (#394, the isolate memory ledger)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLedger, memfsBytes, createSqlMeter, ledgerOn } from '../mem-ledger.mjs';

const MIB = 1048576;
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
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

test('ledger.runtimes: the real WebAssembly.Memory of a retired runtime is sized, even when its wrapper reads 0', () => {
	const l = createLedger();
	const wrapperA = {}, wrapperB = {};
	const memA = new WebAssembly.Memory({ initial: 32 }); // 2 MiB
	const memB = new WebAssembly.Memory({ initial: 16 }); // 1 MiB
	l.register(wrapperA, 1, memA);
	l.register(wrapperB, 2, memB);
	const r = l.runtimes(2, () => 0); // after php.exit the wrapper's HEAPU8 reads 0
	assert.equal(r.retiredMiB, 0, 'the wrapper view cannot size it');
	assert.equal(r.retiredMem, 1);
	assert.equal(r.retiredMemMiB, 2, 'the Memory view does');
	assert.equal(r.currentMemMiB, 1);
	assert.equal(r.memLive, 2);
	memA.grow(16);
	assert.equal(l.runtimes(2, () => 0).retiredMemMiB, 3, 'it reads the live byteLength, after a grow too');
	const nomem = createLedger();
	nomem.register({}, 1);
	assert.equal(nomem.runtimes(1, () => 0).memLive, 0, 'no memory passed: counted as wrapper only');
});

test('index.js: the Memory is taken from the instance export at boot and registered with the runtime', () => {
	assert.match(src, /bootMemory = inst\.exports\.memory \|\| null;/);
	assert.match(src, /ledger\.register\(php, runtimeSerial, bootMemory\);/);
	const reg = src.indexOf('ledger.register(php, runtimeSerial, bootMemory);');
	assert.ok(src.slice(reg, reg + 200).includes('bootMemory = null;'), 'cleared after use, so a later boot cannot reuse it');
});

test('index.js: every snapshot carries what was inflated so far in the request and in the isolate', () => {
	assert.match(src, /inflate: \{ reqN: stats\.inflates - ledgerInfl0\.n, reqMiB: LEDGER_MIB\(stats\.inflateBytes - ledgerInfl0\.b\), isoN: stats\.inflates, isoMiB: LEDGER_MIB\(stats\.inflateBytes\) \}/);
	// The baseline is taken at the request start, before the boot, and at the cron leg start.
	const reqStart = src.indexOf("if (ledgerActive) ledgerLog('start');");
	assert.ok(src.lastIndexOf('ledgerInfl0 = { n: stats.inflates, b: stats.inflateBytes };', reqStart) > reqStart - 200, 'reset just before the start snapshot');
	const cron = src.indexOf("ledgerActive = this.env.MEM_LEDGER === 'on';");
	assert.ok(src.indexOf('ledgerInfl0 = { n: stats.inflates, b: stats.inflateBytes };', cron) - cron < 200, 'reset at the cron leg start');
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


test('index.js: off by default, per request, and snapshots at the memory-limit SQL write, write-loss and end', () => {
	assert.match(src, /ledgerActive = ledgerOn\(env, req\.headers\.get\('x-mem-ledger'\), perfHeadersAllowed\(req, env\)\);/);
	assert.match(src, /ledger\.register\(php, runtimeSerial, bootMemory\);/);
	const sql = src.indexOf('const reply = sqlStatement(sqlDb, m);');
	const blk = src.slice(sql, src.indexOf('return out;', sql));
	assert.match(blk, /if \(ledgerActive\) \{/);
	assert.match(blk, /MEMORY_RESET\.test\(String\(reply\.error \|\| ''\)\) && !ledgerFailLogged/);
	assert.match(blk, /ledgerLog\('sql-memory-fail'/);
	assert.match(src, /if \(lost\) \{\s*if \(ledgerActive\) ledgerLog\('write-loss'/);
	assert.match(src, /\.\.\.\(ledgerActive \? \{ mem: ledgerSnapshot\('end'\) \} : \{\}\)/);
	assert.match(src, /ledgerActive = this\.env\.MEM_LEDGER === 'on';/);
});
