// The render stamp of the cached Pages entrypoint (#628).
//
// The page cache can sit in two layers: the outer one, whose cf-cache-status the client sees, and
// the entrypoint cache of Pages itself, which a ctx.exports.Pages.fetch() call hits without running
// Pages. Cloudflare documents no header that tells the caller about that inner hit. Measured
// 2026-11-15 on pfa-sb1114l (a flat config with a top-level [cache]): 934 front runs and only 21
// Pages runs, with EXPIRED outside on every read. So Pages stamps the time it rendered a page. A
// cached copy keeps the stamp of the run that rendered it: two reads with the same stamp came from a
// cache, and the stamp's age is the age of what a guest sees. tests/load/page_stale.py reads it.
// It is a render time only: no request data, no visitor data.
export const RENDERED_HEADER = 'x-pf-rendered';

export function stampRendered(headers, now = Date.now()) {
	headers.set(RENDERED_HEADER, String(now));
}
