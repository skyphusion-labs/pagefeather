// #1241: six engine suites fail under a plain `node --test` because their CI step
// supplies a precondition (node --expose-gc, the lean loader, a lazy-body engine,
// MAGIC_FILE). Outside CI a missing precondition skips, with the reason. In CI it
// fails, with the same reason. A present precondition runs the test as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const GC_FILES = [
	'spikes/b2-wordpress/tests/mem-ledger-identity.test.mjs',
	'spikes/b2-wordpress/tests/drop-runtime.test.mjs',
	'spikes/b2-wordpress/tests/boot-gate.test.mjs',
];
const LEAN = 'spikes/b2-wordpress/tests/mysql-lean-bridge.test.mjs';
const LAZY = 'spikes/b2-wordpress/tests/lazy-bodies.test.mjs';
const SNIFF = 'spikes/b2-wordpress/tests/fileinfo-sniff.test.mjs';
const LOADER = './spikes/b2-wordpress/tests/fixtures/lean/register.mjs';

const REASON_GC = 'needs node --expose-gc';
const REASON_LEAN = 'needs the lean loader (node --import ./spikes/b2-wordpress/tests/fixtures/lean/register.mjs)';
const REASON_LAZY = 'needs a lazy-body engine';
const REASON_MAGIC = 'needs MAGIC_FILE';

const GC_NAME = 'one memory registered by two runtimes is one live memory, and collected once';
const DROP_NAME = 'after the release, the retirer keeps no reference: the runtime is collected';
const BOOT_NAME = 'the signal is real: a released runtime\'s memory stays alive at full size until V8 collects it, and the test holds none of it';
const DESTROY_NAME = 'LeanMysql.destroy() closes the socket at once, even when a write would never settle';
const SOURCE_NAME = 'DEFAULT PATH: a_main renders index-a-lean.js unless A_CLIENT=mysql2';
const KNOWN_NAME = 'the known differences are still different';

function esc(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function run(args, { ci = false, magic } = {}) {
	const env = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };
	delete env.CI;
	delete env.MAGIC_FILE;
	// A child `node --test` inherits the parent's runner and then runs no files.
	for (const k of Object.keys(env)) if (k.startsWith('NODE_TEST') || k === 'NODE_CHANNEL_FD') delete env[k];
	if (ci) env.CI = 'true';
	if (magic) env.MAGIC_FILE = magic;
	const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...args], {
		cwd: ROOT,
		env,
		encoding: 'utf8',
	});
	return { status: r.status, out: (r.stdout || '') + '\n' + (r.stderr || '') };
}

function lineFor(out, name, failing) {
	const head = failing ? 'not ok ' : 'ok ';
	return out.split('\n').find((l) => l.startsWith(head) && l.includes(name));
}

function assertSkipped(r, name, reason) {
	assert.equal(r.status, 0, r.out);
	const line = lineFor(r.out, name, false);
	assert.ok(line, 'no skip line for ' + name + '\n' + r.out);
	assert.match(line, new RegExp('# SKIP ' + esc(reason)));
}

function assertFailed(r, name, reason) {
	assert.notEqual(r.status, 0, r.out);
	assert.ok(lineFor(r.out, name, true), 'no fail line for ' + name + '\n' + r.out);
	assert.match(r.out, new RegExp(esc(reason)));
	assert.doesNotMatch(r.out, new RegExp('# SKIP ' + esc(reason)));
}

function assertPassedLine(out, name) {
	const line = lineFor(out, name, false);
	assert.ok(line, 'no pass line for ' + name + '\n' + out);
	assert.doesNotMatch(line, /# SKIP/);
}

function assertPassed(r, name) {
	assert.equal(r.status, 0, r.out);
	assertPassedLine(r.out, name);
}

const slow = { timeout: 300000 };

test.describe('missing preconditions and present ones (#1241)', { concurrency: 1 }, () => {
	test('gc missing, CI unset: the three gc tests skip and the run exits 0', () => {
		const r = run(GC_FILES);
		assertSkipped(r, GC_NAME, REASON_GC);
		assertSkipped(r, DROP_NAME, REASON_GC);
		assertSkipped(r, BOOT_NAME, REASON_GC);
	});

	test('gc missing, CI set: the three gc tests fail with the same reason', () => {
		const r = run(GC_FILES, { ci: true });
		assertFailed(r, GC_NAME, REASON_GC);
		assertFailed(r, DROP_NAME, REASON_GC);
		assertFailed(r, BOOT_NAME, REASON_GC);
	});

	test('gc present: the three gc tests run and pass, CI unset and CI set', slow, () => {
		for (const ci of [false, true]) {
			const r = run(['--expose-gc', ...GC_FILES], { ci });
			assertPassed(r, GC_NAME);
			assertPassed(r, DROP_NAME);
			assertPassed(r, BOOT_NAME);
		}
	});

	test('lean loader missing, CI unset: loader tests skip, source tests still run', slow, () => {
		const r = run([LEAN]);
		assertSkipped(r, DESTROY_NAME, REASON_LEAN);
		assertPassed(r, SOURCE_NAME);
	});

	test('lean loader missing, CI set: loader tests fail with the same reason', slow, () => {
		const r = run([LEAN], { ci: true });
		assertFailed(r, DESTROY_NAME, REASON_LEAN);
		assertPassedLine(r.out, SOURCE_NAME);
	});

	test('lean loader present: the suite runs and passes, CI unset and CI set', slow, () => {
		for (const ci of [false, true]) {
			const r = run(['--import', LOADER, LEAN], { ci });
			assertPassed(r, DESTROY_NAME);
			assertPassed(r, SOURCE_NAME);
		}
	});

	test('lazy-body engine missing, CI unset: the five tests skip and the run exits 0', slow, () => {
		const r = run([LAZY]);
		assert.equal(r.status, 0, r.out);
		assert.match(r.out, new RegExp('# SKIP ' + esc(REASON_LAZY)));
		assert.equal((r.out.match(/# SKIP /g) || []).length, 5, r.out);
	});

	test('lazy-body engine missing, CI set: the tests fail with the same reason', slow, () => {
		const r = run([LAZY], { ci: true });
		assert.notEqual(r.status, 0, r.out);
		assert.match(r.out, new RegExp(esc(REASON_LAZY)));
		assert.match(r.out, /not ok /);
		assert.doesNotMatch(r.out, new RegExp('# SKIP ' + esc(REASON_LAZY)));
	});

	test('MAGIC_FILE missing, CI unset: the known-diff test skips and the run exits 0', slow, () => {
		const r = run([SNIFF]);
		assertSkipped(r, KNOWN_NAME, REASON_MAGIC);
	});

	test('MAGIC_FILE missing, CI set: the known-diff test fails with the same reason', slow, () => {
		const r = run([SNIFF], { ci: true });
		assertFailed(r, KNOWN_NAME, REASON_MAGIC);
	});

	test('MAGIC_FILE present: the sniff runs and is not skipped, CI unset and CI set', slow, () => {
		// A file that is not a database still takes the MAGIC_FILE path. The suite
		// must not skip it. The same path runs the real trimmed database in the engine workflow.
		const magic = join(mkdtempSync(join(tmpdir(), 'pf1241-')), 'not-a-database.mgc');
		writeFileSync(magic, 'not a magic database');
		for (const ci of [false, true]) {
			const r = run([SNIFF], { ci, magic });
			assert.doesNotMatch(r.out, new RegExp('# SKIP ' + esc(REASON_MAGIC)));
			assert.match(r.out, /finfo_open|known differences/);
		}
	});
});
