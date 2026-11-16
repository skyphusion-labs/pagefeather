// node deploy/provision/tests/vendor-sync-test.mjs (#739): the one-click site manager runs byte-identical copies of
// deploy/provision/*.mjs (deploy/oneclick/vendor/provision/, sync-vendor.sh). An edit here without
// `deploy/oneclick/sync-vendor.sh` used to fail only CI's WfP reference step (#724 and #738, 2026-11-16), because
// only the oneclick suite compared the copies. Now the provision suite fails too, naming the file and the fix.
import { mkdtempSync, mkdirSync, copyFileSync, appendFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { vendorCheck, SYNC } from '../../oneclick/tests/vendor-check.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// 1. This tree: every provision copy equals its source.
const r = vendorCheck('deploy/provision/');
ok(`every vendored copy of deploy/provision equals its source (rc ${r.code}: ${r.out.trim().split('\n').pop()})`, r.code === 0 && /pairs? equal/.test(r.out));

// 2. The guard fails on a real difference: a temp tree with the script and the provision pairs, one source edited.
const T = mkdtempSync(join(tmpdir(), 'vendor-sync-test-'));
try {
	mkdirSync(join(T, 'deploy', 'oneclick'), { recursive: true });
	copyFileSync(SYNC, join(T, 'deploy', 'oneclick', 'sync-vendor.sh'));
	const pairs = spawnSync('bash', [SYNC, '--list'], { encoding: 'utf8' }).stdout.trim().split('\n').map((l) => l.split(' '));
	for (const [src, dst] of pairs) {
		for (const [from, to] of [[join(root, src), join(T, src)], [join(root, 'deploy', 'oneclick', dst), join(T, 'deploy', 'oneclick', dst)]]) {
			mkdirSync(dirname(to), { recursive: true });
			copyFileSync(from, to);
		}
	}
	const tmpSync = join(T, 'deploy', 'oneclick', 'sync-vendor.sh');
	ok('the temp tree starts equal', vendorCheck('deploy/provision/', tmpSync).code === 0);
	appendFileSync(join(T, 'deploy', 'provision', 'ops.mjs'), '\n// an edit without a sync\n');
	const d = vendorCheck('deploy/provision/', tmpSync);
	ok('an edited source without a sync: rc 1', d.code === 1);
	ok('  it names the source and the fix', d.out.includes('deploy/provision/ops.mjs') && d.out.includes('deploy/oneclick/sync-vendor.sh'));
	ok('  and copies nothing (a check, not a sync)', readFileSync(join(T, 'deploy', 'oneclick', 'vendor', 'provision', 'ops.mjs'), 'utf8') !== readFileSync(join(T, 'deploy', 'provision', 'ops.mjs'), 'utf8'));
	ok('another prefix is not affected (release pairs still equal)', vendorCheck('deploy/release/', tmpSync).code === 0);
	spawnSync('bash', [tmpSync], { encoding: 'utf8' });
	ok('after a sync the check passes again', vendorCheck('deploy/provision/', tmpSync).code === 0);
	const none = vendorCheck('deploy/nothing-here/', tmpSync);
	ok('a prefix that matches no pair is rc 2 (a check that measured nothing is not a pass)', none.code === 2);
	const bare = spawnSync('bash', [tmpSync, '--check'], { encoding: 'utf8' });
	ok('--check with no prefix checks every pair (rc 0 here)', bare.status === 0 && /pairs? equal/.test(bare.stdout));
} finally {
	rmSync(T, { recursive: true, force: true });
}
console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
