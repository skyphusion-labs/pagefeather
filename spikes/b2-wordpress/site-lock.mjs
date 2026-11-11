// The demo lock. A public demo site (deploy/provision, demo: true) is built with
// DEMO_LOCK=on and with no send_email binding. With the lock on:
//   - the site sends no mail, even if a binding is present (sendEmail in index.js);
//   - WordPress cannot install, update or edit plugin or theme code
//     (DISALLOW_FILE_MODS and DISALLOW_FILE_EDIT in the generated wp-config).
// Every other site has no DEMO_LOCK var, so this changes nothing for them.

export function demoLocked(env) {
	return !!env && env.DEMO_LOCK === 'on';
}

// The wp-config lines the lock adds. Empty when the lock is off.
export function demoLockDefines(env) {
	if (!demoLocked(env)) return [];
	return ["define('DISALLOW_FILE_MODS', true);", "define('DISALLOW_FILE_EDIT', true);"];
}
