// Mutates the Playwright FullConfig so upstream global-setup.js sees storageState on
// projects[0].use. Upstream reads only that field, not config.use (#759, measured conf759).
export function applyStorageStatePath( config ) {
	const statePath =
		process.env.STORAGE_STATE_PATH ||
		( typeof config.use?.storageState === 'string' ? config.use.storageState : undefined );
	const baseURL = config.use?.baseURL || process.env.WP_BASE_URL || process.env.BASE_URL;
	const usePatch = {
		...( statePath ? { storageState: statePath } : {} ),
		...( baseURL ? { baseURL } : {} ),
	};
	if ( ! Object.keys( usePatch ).length ) {
		return;
	}
	config.use = { ...config.use, ...usePatch };
	if ( config.projects?.[ 0 ] ) {
		config.projects[ 0 ].use = { ...config.projects[ 0 ].use, ...usePatch };
	}
}