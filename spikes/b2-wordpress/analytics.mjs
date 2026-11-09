// Pure helpers for the privacy-friendly pageview analytics op (#201 Phase 2).
// index.js imports these for analyticsOp and the config gate;
// tests/analytics.test.mjs tests them. No side effects, so both can import
// without booting a Worker.
//
// The op records ONE anonymized pageview to a Cloudflare Analytics Engine
// dataset through env.ANALYTICS.writeDataPoint. The design mirrors ai-alt-text
// and zone-cache-purge: PHP gathers the request facts (host, path, status,
// country) and sends an `analytics` op; the Worker holds the binding and does the
// writeDataPoint. There is no cookie, no IP, no user agent and no query string:
// the ONE field that could become a per-visitor tracking key is the index, and it
// is deliberately set to the site HOST (site level), never anything per-visitor.

// Data-point field caps. Analytics Engine allows up to 20 blobs and 20 doubles,
// one index, and a generous per-string size; these caps are well under the limit
// and keep a single malformed field from bloating a write. A blob or index over
// its cap is truncated, never dropped, so the write always has a stable shape.
export const HOST_MAX = 128;
export const PATH_MAX = 512;
export const STATUS_MAX = 8;
export const COUNTRY_MAX = 8;

// Coerce to a string and cap its length. null/undefined/number all become a
// bounded string, so buildDataPoint never emits a non-string blob or index.
function clip(v, max) {
	let s = v == null ? '' : String(v);
	if (s.length > max) s = s.slice(0, max);
	return s;
}

// Strip the query string and fragment from a path, keep a single leading slash.
// PHP already sends a path with no query, but strip again here so a stray query
// (or a caller that forgets) never reaches the dataset: the query can carry
// search terms or tokens, which is exactly what a privacy-friendly pageview
// metric must not store.
export function sanitizePath(v) {
	let s = v == null ? '' : String(v);
	const cut = s.search(/[?#]/);
	if (cut >= 0) s = s.slice(0, cut);
	if (s === '') s = '/';
	else if (s.charCodeAt(0) !== 47) s = '/' + s; // ensure a leading '/'
	return clip(s, PATH_MAX);
}

// Build the Analytics Engine data point for one pageview op. Pure: the same op
// always yields the same point, so the test asserts the exact shape.
//
//   blobs  = [ host, path, status, country ]   (blob1..blob4; GROUP BY columns)
//   doubles = [ 1 ]                             (double1 = count; COUNT/SUM + the
//                                                sample-interval ratio both work)
//   indexes = [ host ]                          (index1; the sampling + filter key,
//                                                site level, never per-visitor)
export function buildDataPoint(op) {
	const o = op || {};
	const host = clip(o.host, HOST_MAX);
	return {
		blobs: [host, sanitizePath(o.path), clip(o.status, STATUS_MAX), clip(o.country, COUNTRY_MAX)],
		doubles: [1],
		indexes: [host],
	};
}

// Record one pageview on a dataset binding. This is the shared seam the op test
// stubs (a fake dataset whose writeDataPoint captures the point), exactly as
// turnstile's verifyToken is the seam its box test exercises. writeDataPoint is
// fire-and-forget (returns void), so this returns void too and never awaits.
export function recordPageview(dataset, op) {
	dataset.writeDataPoint(buildDataPoint(op));
}

// Whether index.js should inject define('SKYPHUSION_ANALYTICS', true): the DO
// profile (PHP and the database in the Durable Object), the ANALYTICS binding
// present, and WP_ANALYTICS explicitly 'on'. Analytics has a privacy
// implication, so unlike the default-on gates this is OPT-IN: it activates only
// when WP_ANALYTICS is 'on' (the opt-in descriptor sets it), never merely because
// a binding happens to be present. A site that never opts in is byte-identical.
export function analyticsEnabled(env) {
	return !!(
		env &&
		env.PHP_IN_DO === 'on' &&
		env.DB_IN_DO === 'on' &&
		env.ANALYTICS &&
		env.WP_ANALYTICS === 'on'
	);
}
