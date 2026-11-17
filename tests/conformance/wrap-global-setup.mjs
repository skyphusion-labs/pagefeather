// Mutates the Playwright FullConfig so upstream global-setup.js sees storageState on
// projects[0].use. Upstream reads only that field, not config.use (#759, measured conf759).
export function applyStorageStatePath( config ) {
	const statePath =
		typeof config.use?.storageState === 'string'
			? config.use.storageState
			: process.env.STORAGE_STATE_PATH;
	if ( ! statePath ) {
		return;
	}
	config.use = { ...config.use, storageState: statePath };
	if ( config.projects?.[ 0 ] ) {
		config.projects[ 0 ].use = { ...config.projects[ 0 ].use, storageState: statePath };
	}
}