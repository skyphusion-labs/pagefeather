// node --test spikes/b2-wordpress/tests/engine-contract-tmpdir.test.mjs (#612).
// Importing engine-contract.mjs makes one engine582-* directory for loader copies.
// The process must remove it on exit, including a failing run, and the name must
// carry the seat (PAGEFEATHER_SEAT) or the pid so a leftover can be attributed.
// Needs npm ci in spikes/b2-wordpress (the module loads @php-wasm/universal). It does
// not boot the engine, so it does not need ./prepare.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The child imports the real module, writes a loader copy into the dir it made,
// and prints the name. The parent checks the fresh TMPDIR after the child exits.
function importContract(extraEnv, exitCode) {
	const fresh = mkdtempSync(join(tmpdir(), 'pf612-'));
	const env = { ...process.env, TMPDIR: fresh, ...extraEnv };
	const code = exitCode === undefined ? '' : '\nprocess.exit(' + exitCode + ');\n';
	const child = spawnSync(process.execPath, ['--input-type=module', '-e', [
		"import { readdirSync, writeFileSync } from 'node:fs';",
		"import { join } from 'node:path';",
		"await import('./engine-contract.mjs');",
		"const names = readdirSync(process.env.TMPDIR).filter((n) => n.startsWith('engine582-'));",
		"for (const n of names) writeFileSync(join(process.env.TMPDIR, n, 'loader-0.mjs'), 'export {}\\n');",
		"console.log(JSON.stringify({ pid: process.pid, names }));",
		code,
	].join('\n')], { cwd: here, env, encoding: 'utf8' });
	return { fresh, child };
}

function report(child) {
	const line = child.stdout.trim().split('\n').pop();
	return JSON.parse(line);
}

test('importing engine-contract.mjs leaves no engine582 dir after exit (#612)', () => {
	const seat = 'seat612';
	const { fresh, child } = importContract({ PAGEFEATHER_SEAT: seat });
	try {
		assert.equal(child.status, 0, child.stderr || child.stdout);
		const info = report(child);
		const left = readdirSync(fresh).filter((n) => n.startsWith('engine582-'));
		assert.deepEqual(left, [], 'left ' + left.join(','));
		assert.equal(info.names.length, 1);
		assert.match(info.names[0], new RegExp('^engine582-' + seat + '-' + info.pid + '-[A-Za-z0-9]{6}$'));
	} finally {
		rmSync(fresh, { recursive: true, force: true });
	}
});

test('a failing import of engine-contract.mjs still removes the engine582 dir (#612)', () => {
	const { fresh, child } = importContract({ PAGEFEATHER_SEAT: 'seat612' }, 1);
	try {
		assert.equal(child.status, 1, child.stderr || child.stdout);
		const left = readdirSync(fresh).filter((n) => n.startsWith('engine582-'));
		assert.deepEqual(left, [], 'left ' + left.join(','));
	} finally {
		rmSync(fresh, { recursive: true, force: true });
	}
});

test('the engine582 dir name carries the pid when no seat is set (#612)', () => {
	const { fresh, child } = importContract({ PAGEFEATHER_SEAT: '' });
	try {
		assert.equal(child.status, 0, child.stderr || child.stdout);
		const info = report(child);
		const left = readdirSync(fresh).filter((n) => n.startsWith('engine582-'));
		assert.deepEqual(left, [], 'left ' + left.join(','));
		assert.equal(info.names.length, 1);
		assert.match(info.names[0], new RegExp('^engine582-' + info.pid + '-[A-Za-z0-9]{6}$'));
	} finally {
		rmSync(fresh, { recursive: true, force: true });
	}
});
