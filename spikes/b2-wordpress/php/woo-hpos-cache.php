<?php
/**
 * Plugin Name: WooCommerce HPOS Data Caching (approach A)
 * Description: When WOO_HPOS_CACHE=on on an approach-A site, WooCommerce's HPOS Data Caching reads as on. Unset
 *   leaves WooCommerce's own setting (off by default in 11.2.1). #697.
 *
 * The Worker defines SKYPHUSION_WOO_HPOS_CACHE as 'on' only on approach A and only with WOO_HPOS_CACHE=on
 * (woo-hpos-cache.mjs). The pre_option filter answers "yes" before the database is read, so a stored "no" cannot
 * turn it back off, and nothing is written.
 *
 * From the pinned WooCommerce 11.2.1 (WOO_VERSION in build.sh):
 *   - the option is CustomOrdersTableController::HPOS_DATASTORE_CACHING_ENABLED_OPTION,
 *     'woocommerce_hpos_datastore_caching_enabled' (feature hpos_datastore_caching, enabled_by_default false);
 *   - hpos_data_caching_is_enabled() is get_option( that ) === 'yes' AND HPOS in use, so on a store that keeps
 *     orders in posts this changes nothing;
 *   - the cache is wp_cache in the group 'orders_data' (OrdersTableDataStore::get_cache_group). On approach A the
 *     object-cache drop-in persists only allowlisted or salted groups, so it lives for one request only.
 */

if ( ! defined( 'SKYPHUSION_WOO_HPOS_CACHE' ) || 'on' !== SKYPHUSION_WOO_HPOS_CACHE ) {
	return;
}

// Late, so a normal pre_option callback cannot put a stored "no" back (as woo-extras.php does).
add_filter(
	'pre_option_woocommerce_hpos_datastore_caching_enabled',
	static function () {
		return 'yes';
	},
	9999
);
