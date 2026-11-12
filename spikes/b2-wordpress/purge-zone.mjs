// Pure helpers for the zone cache purge-on-publish op (issue #205). index.js
// imports these for purgeZoneOp and the config gate; tests/purge-zone.test.mjs
// tests them. No side effects, so both can import without booting a Worker.

// Cloudflare Free allows up to 30 URLs in one POST /zones/{zone}/purge_cache
// call (purge by URL). More than that from one request (a bulk edit) falls back
// to a purge of the site's own host, so a request never needs more than one
// purge call.
export const PURGE_URL_CAP = 30;

// The host a site may purge: the hostname of its own origin (SITE_ORIGIN),
// lower case. '' when the origin is missing or not a URL. A zone can hold many
// sites, so a site purges only its own host, never the whole zone.
export function ownPurgeHost(siteOrigin) {
	try {
		return new URL(String(siteOrigin || '')).hostname.toLowerCase();
	} catch {
		return '';
	}
}

// The Cloudflare cache-purge endpoint for a zone. The zone id is path-encoded so
// a malformed binding cannot break out of the path.
export function cfPurgeEndpoint(zoneId) {
	return `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`;
}

// Keep absolute http(s) URLs only, in order, without duplicates. PHP sends the
// permalink, the home page and the feed, which overlap across hooks in one
// request; this collapses them. With host, a URL on any other host is dropped.
export function dedupeFiles(files, host) {
	if (!Array.isArray(files)) return [];
	const seen = new Set();
	const out = [];
	for (const f of files) {
		if (typeof f !== 'string') continue;
		const u = f.trim();
		if (!u || !/^https?:\/\//i.test(u)) continue;
		if (host) {
			let h = '';
			try { h = new URL(u).hostname.toLowerCase(); } catch { h = ''; }
			if (h !== host) continue;
		}
		if (seen.has(u)) continue;
		seen.add(u);
		out.push(u);
	}
	return out;
}

// The body for POST /zones/{zone}/purge_cache, from what PHP queued, for the
// site whose own host is host (ownPurgeHost).
//   { everything: true }  -> { hosts: [host] }     (a theme or site change)
//   { files: [...] }      -> { files: [deduped] }  (specific URLs on host only)
// Over the cap -> { hosts: [host] } (one call, never a partial purge). No usable
// URL -> null (the caller then makes no call: nothing changed that is on a page).
// No host -> null: the site cannot name its own host, so it purges nothing
// rather than the whole zone. The body never purges the whole zone.
export function purgeZoneBody(op, host) {
	if (!host) return null;
	if (!op || op.everything) return { hosts: [host] };
	const files = dedupeFiles(op.files, host);
	if (files.length === 0) return null;
	if (files.length > PURGE_URL_CAP) return { hosts: [host] };
	return { files };
}

// Whether index.js should inject define('SKYPHUSION_CACHE_PURGE', true): the DO
// profile (PHP and the database in the Durable Object), the scoped Cache Purge
// token and the zone id both present, and CACHE_PURGE not turned off. Default on
// when the bindings are present, off otherwise, so a site with no zone cache
// never calls the purge API.
export function cachePurgeEnabled(env) {
	return !!(
		env &&
		env.PHP_IN_DO === 'on' &&
		env.DB_IN_DO === 'on' &&
		env.PURGE_TOKEN &&
		env.PURGE_ZONE &&
		env.CACHE_PURGE !== 'off'
	);
}
