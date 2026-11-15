// #697: WooCommerce's HPOS Data Caching (feature hpos_datastore_caching) for approach A, default OFF. The Worker
// defines SKYPHUSION_WOO_HPOS_CACHE only on approach A (the Hyperdrive dbHandler is set) and only when WOO_HPOS_CACHE
// is exactly "on"; php/woo-hpos-cache.php then answers the option "yes". On approach A it is per request only:
// WooCommerce caches through wp_cache in the group orders_data, which the object-cache drop-in does not persist there
// (not allowlisted, not salted), so no isolate shares it (#296 step 3, arm C). b-dosql is never touched.
export function hposCacheDefine(env, approachA) {
	return approachA && env && env.WOO_HPOS_CACHE === 'on' ? "define('SKYPHUSION_WOO_HPOS_CACHE', 'on');" : null;
}
