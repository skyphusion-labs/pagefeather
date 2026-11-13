// The site locks.
//
//   The CODE LOCK is on for EVERY site (#458, Conrad 2026-11-13): wp-admin is for the standard CMS
//   work; core, plugin and theme installs, updates and edits are code deploys ("updating wordpress
//   core and plugins from the dashboard is a security risk anyway"). It is DISALLOW_FILE_MODS and
//   DISALLOW_FILE_EDIT in the generated wp-config, so Plugins > Add New, updates and the plugin and
//   theme editors are not offered. Activating and deactivating a plugin, and switching themes,
//   still work. The Plugins and Themes screens say how to add one (php/code-lock-notice.php).
//   CODE_LOCK=off turns it off, for a LOCAL or THROWAWAY test instance only (a measurement that
//   installs from wp-admin). No deploy tool renders it (deploy/wfp, deploy/deploy.sh and
//   deploy/provision never set off), so a deployed site cannot turn it off.
//   DEMO_LOCK=on  a public demo site (demo: true). It also has no send_email binding:
//                 the site sends no mail, even if a binding is present (sendEmail in index.js).
//                 A demo site is always code-locked, CODE_LOCK=off included.

export function demoLocked(env) {
	return !!env && env.DEMO_LOCK === 'on';
}

// Plugin and theme code is locked on every site, and always on a demo site.
export function codeLocked(env) {
	return demoLocked(env) || !(!!env && env.CODE_LOCK === 'off');
}

// The wp-config lines the locks add. A demo site keeps exactly the two defines it had before
// #406 (its own notice is the demo's); every other locked site also gets the notice constant.
export function lockDefines(env) {
	if (!codeLocked(env)) return [];
	const lines = ["define('DISALLOW_FILE_MODS', true);", "define('DISALLOW_FILE_EDIT', true);"];
	if (!demoLocked(env)) lines.push("define('SKYPHUSION_CODE_LOCK', true);");
	return lines;
}
