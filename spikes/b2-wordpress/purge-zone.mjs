// Pure helpers for the zone cache purge-on-publish op (issue #205). index.js
// imports these for purgeZoneOp and the config gate; tests/purge-zone.test.mjs
// tests them. No side effects, so both can import without booting a Worker.

// Cloudflare Free allows up to 30 URLs in one POST /zones/{zone}/purge_cache
// call (purge by URL). More than that from one request (a bulk edit) falls back
// to purge_everything, so a request never needs more than one purge call.
export const PURGE_URL_CAP = 30;

// The Cloudflare cache-purge endpoint for a zone. The zone id is path-encoded so
// a malformed binding cannot break out of the path.
export function cfPurgeEndpoint(zoneId) {
	return `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`;
}

// Keep absolute http(s) URLs only, in order, without duplicates. PHP sends the
// permalink, the home page and the feed, which overlap across hooks in one
// request; this collapses them.
export function dedupeFiles(files) {
	if (!Array.isArray(files)) return [];
	const seen = new Set();
	const out = [];
	for (const f of files) {
		if (typeof f !== 'string') continue;
		const u = f.trim();
		if (!u || !/^https?:\/\//i.test(u)) continue;
		if (seen.has(u)) continue;
		seen.add(u);
		out.push(u);
	}
	return out;
}

// The body for POST /zones/{zone}/purge_cache, from what PHP queued.
//   { everything: true }  -> { purge_everything: true }  (a theme or site change)
//   { files: [...] }      -> { files: [deduped] }        (specific URLs)
// Over the cap -> purge_everything (one call, never a partial purge). No usable
// URL -> null (the caller then makes no call: nothing changed that is on a page).
export function purgeZoneBody(op) {
	if (!op || op.everything) return { purge_everything: true };
	const files = dedupeFiles(op.files);
	if (files.length === 0) return null;
	if (files.length > PURGE_URL_CAP) return { purge_everything: true };
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
