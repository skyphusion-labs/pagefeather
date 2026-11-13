// The site locks. Two vars, set by deploy/provision when it builds a site:
//
//   DEMO_LOCK=on  a public demo site (demo: true). It also has no send_email binding.
//                 - the site sends no mail, even if a binding is present (sendEmail in index.js);
//                 - WordPress cannot install, update or edit plugin or theme code.
//   CODE_LOCK=on  a one-click site (issue #406). Mail is unchanged.
//                 - WordPress cannot install, update or edit plugin or theme code, because a
//                   plugin or theme installed from wp-admin does not persist (docs/plugins.md);
//                 - the Plugins and Themes screens say why (php/code-lock-notice.php).
//
// The code lock is DISALLOW_FILE_MODS and DISALLOW_FILE_EDIT in the generated wp-config.
// A site with neither var gets no extra define, so this changes nothing for it.

export function demoLocked(env) {
	return !!env && env.DEMO_LOCK === 'on';
}

// Plugin and theme code is locked on a demo site and on a one-click site.
export function codeLocked(env) {
	return demoLocked(env) || (!!env && env.CODE_LOCK === 'on');
}

// The wp-config lines the locks add. Empty when no lock is on. A demo site keeps
// exactly the two defines it had before #406; the notice constant is for CODE_LOCK.
export function lockDefines(env) {
	if (!codeLocked(env)) return [];
	const lines = ["define('DISALLOW_FILE_MODS', true);", "define('DISALLOW_FILE_EDIT', true);"];
	if (!demoLocked(env)) lines.push("define('SKYPHUSION_CODE_LOCK', true);");
	return lines;
}
