<?php
/**
 * Plugin Name: WooCommerce bootstrap trim (b-dosql)
 * Description: Skips pure-background WooCommerce Admin features that re-initialise on
 *   every request (front-end and admin) but only do remote woocommerce.com work this
 *   deployment never uses. Gated to b-dosql via SKYPHUSION_BOOTSTRAP_TRIM.
 *
 * Grounded in WooCommerce 11.2.1 source:
 *   - FeaturePlugin hooks plugins_loaded:9 and Features hooks init:4, so wc-admin
 *     initialises on EVERY request including the front end, not only in wp-admin.
 *   - The active feature set is filterable via woocommerce_admin_features
 *     (src/Admin/Features/Features.php). Dropping a slug skips that feature's init.
 *   - remote-inbox-notifications and marketing are pure background/remote (they poll
 *     woocommerce.com); they have no front-end behaviour and tests/woo.py does not
 *     exercise them. launch-your-store (the coming-soon front-end gate), analytics
 *     and activity-panels are KEPT, so coming-soon enforcement, the orders screen and
 *     the wc-admin REST endpoints are unaffected.
 *   - remote-inbox-notifications is declared optional in Features.php, so removing it
 *     is a supported configuration.
 *
 * Deliberately NOT trimmed here (measured already gated, so a front-end trim is a
 * no-op): Action Scheduler's shutdown dispatch (maybe_dispatch_async_request returns
 * before any query unless is_admin()), marketplace suggestions (includes/admin only),
 * and usage tracking (runs via Action Scheduler in admin/cron context).
 */

if ( ! defined( 'SKYPHUSION_BOOTSTRAP_TRIM' ) || ! SKYPHUSION_BOOTSTRAP_TRIM ) {
	return;
}

add_filter(
	'woocommerce_admin_features',
	function ( $features ) {
		$drop = array( 'remote-inbox-notifications', 'marketing' );
		return array_values( array_diff( (array) $features, $drop ) );
	},
	20
);
