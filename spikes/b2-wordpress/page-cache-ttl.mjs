// C2 of #628: a shorter edge TTL for WooCommerce product pages only, behind PAGE_CACHE_PRODUCT_TTL.
//
// Measured on pf628 (2026-11-15): a checkout that lowers a stock QUANTITY asks no purge, so a cached
// product page showed the old number for the whole 120 s TTL. stale-while-revalidate=600 makes the
// first visitor after a quiet spell see a copy up to 720 s old. A purge on every sale would spend the
// account's 5 purges a minute and empty every page of the site. So, behind a flag and measured first:
// product, shop and product-category pages get their own TTL, and the stale window is cut to match.
//
// Unset (the default): the rule is byte for byte today's, for every page.
// The mark x-pf-page: product comes from php/edge-cache.php; index.js removes it from every answer.
export const PRODUCT_PAGE_HEADER = 'x-pf-page';
const MIN_S = 5;
const MAX_S = 600;
export const STALE_S = 600;

/** PAGE_CACHE_PRODUCT_TTL as seconds, or null when unset or not an integer from 5 to 600. */
export function productTtl(env) {
	const raw = env && env.PAGE_CACHE_PRODUCT_TTL;
	if (typeof raw !== 'string' || !/^[0-9]{1,3}$/.test(raw)) return null;
	const n = Number(raw);
	return n >= MIN_S && n <= MAX_S ? n : null;
}

/** True when PHP marked the page as a product, shop or product-category page. */
export function isProductPage(phpHeaders) {
	const v = phpHeaders && phpHeaders[PRODUCT_PAGE_HEADER];
	return [].concat(v == null ? [] : v).some((x) => String(x).trim() === 'product');
}

/** The cloudflare-cdn-cache-control value for a cacheable page. */
export function edgeCacheControl(ttl, prodTtl, isProduct) {
	if (prodTtl && isProduct) {
		const t = Math.min(prodTtl, ttl);
		return `max-age=${t}, stale-while-revalidate=${t}`;
	}
	return `max-age=${ttl}, stale-while-revalidate=${STALE_S}`;
}
