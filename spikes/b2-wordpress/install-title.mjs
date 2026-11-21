// #1098: the blog title a new install stores. An explicit title wins. With none,
// the site name (site add, or the deploy name) wins. With neither, the hostname.
// Never a product name. An empty result means "do not install": the caller
// reports it, and an already installed site is left unchanged.
const MAX = 200;

export function cleanTitle(value) {
	if (typeof value !== 'string') return '';
	const t = value.trim();
	if (!t || t.length > MAX || /[\u0000-\u001F\u007F]/.test(t)) return '';
	return t;
}

// Hostname of a site origin. "internal" is the dispatch-binding install URL,
// not a site, so it is not a title.
export function hostFromOrigin(origin) {
	if (typeof origin !== 'string' || !origin.trim()) return '';
	const raw = origin.trim();
	try {
		const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
		const host = u.hostname || '';
		if (!host || host === 'internal') return '';
		return host;
	} catch {
		return '';
	}
}

export function installSiteTitle({ title, siteName, host } = {}) {
	return cleanTitle(title) || cleanTitle(siteName) || cleanTitle(host) || '';
}

// SITE_TITLE=... node install-title.mjs --toml
// One [vars] line, or exit 1. A value that is empty, too long, or has a control
// character is refused. It is not turned into a different title. A Worker import
// does not take this path (mail-from.mjs uses the same guard).
const invoked = process.argv[1] && process.argv[1].endsWith('install-title.mjs');
if (invoked && process.argv[2] === '--toml') {
	const t = cleanTitle(process.env.SITE_TITLE || '');
	if (!t) {
		console.error('SITE_TITLE must be one line of 1 to 200 characters');
		process.exit(1);
	}
	const esc = t.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	process.stdout.write(`SITE_TITLE = "${esc}"\n`);
}
