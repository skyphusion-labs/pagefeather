// Playwright globalSetup entry (#759): strings only in config.globalSetup. Applies storageState
// to projects[0].use, then runs the upstream auth global-setup module named by env.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyStorageStatePath } from './wrap-global-setup.mjs';

export default async function pfGlobalSetup( config ) {
	applyStorageStatePath( config );
	const rel = process.env.PF_CONFORMANCE_UPSTREAM_GLOBAL_SETUP;
	if ( ! rel ) {
		throw new Error( 'pf-global-setup: PF_CONFORMANCE_UPSTREAM_GLOBAL_SETUP is not set' );
	}
	const mod = await import( pathToFileURL( path.resolve( rel ) ).href );
	const upstream = mod.default;
	if ( typeof upstream !== 'function' ) {
		throw new Error( 'pf-global-setup: upstream default export is not a function: ' + rel );
	}
	await upstream( config );
}