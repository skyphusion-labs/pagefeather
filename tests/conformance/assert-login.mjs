// A Playwright globalSetup that runs AFTER the upstream one (#759, lead ruling): it STOPS the run
// unless the saved login is real. The upstream auth setup never checks its response, so an empty
// storage state would read as hundreds of test failures. runner.py check-state does the check (one
// implementation, tested in runner_test.py); a non-zero exit throws here and Playwright aborts.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUNNER = fileURLToPath( new URL( './runner.py', import.meta.url ) );

export default async function assertLogin( config ) {
	const use = ( config.projects[ 0 ] && config.projects[ 0 ].use ) || {};
	const state = typeof use.storageState === 'string' ? use.storageState : process.env.STORAGE_STATE_PATH;
	const base = use.baseURL || process.env.WP_BASE_URL;
	if ( ! state || ! base ) {
		throw new Error( 'assert-login: no storage state path or base URL in the config' );
	}
	execFileSync( 'python3', [ '-I', RUNNER, 'check-state', '--base-url', base, '--state', state ], { stdio: 'inherit' } );
}
