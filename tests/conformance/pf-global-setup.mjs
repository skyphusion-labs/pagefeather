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
	const target = path.isAbsolute( rel ) ? rel : path.resolve( rel );
	const mod = await import( pathToFileURL( target ).href );
	const upstream = ( typeof mod.default === 'function' && mod.default ) || ( typeof mod.default?.default === 'function' && mod.default.default ) || mod;
	if ( typeof upstream !== 'function' ) {
		throw new Error(
			'pf-global-setup: upstream default export is not a function: ' +
				rel +
				' (typeof default ' +
				typeof mod.default +
				')'
		);
	}
	await upstream( config );
}