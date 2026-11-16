// #739: the shared vendored-copy check for the suites that edit a vendored source (deploy/provision,
// deploy/release, deploy/wfp/dispatcher). deploy/oneclick/vendor holds byte-identical copies of them
// (sync-vendor.sh PAIRS); before #739 only the oneclick suite compared them, so an edit to a source was
// caught only in CI (#724, #738 on 2026-11-16). vendorCheck(prefix) runs `sync-vendor.sh --check <prefix>`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const SYNC = join(here, '..', 'sync-vendor.sh');

/** { code, out } of `sync-vendor.sh --check <prefix>` (stdout and stderr together), from the given script. */
export function vendorCheck(prefix, script = SYNC) {
	const r = spawnSync('bash', [script, '--check', prefix], { encoding: 'utf8' });
	return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
