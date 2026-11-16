<?php
/**
 * Plugin Name: Conformance test plugins (#759)
 * Description: Loads the upstream test plugins that WordPress's and WooCommerce's own test suites need, ONLY
 *   on a throwaway site deployed with CONFORMANCE=on. index.js defines SKYPHUSION_CONFORMANCE from the site var
 *   CONFORMANCE = "on", and the deploy refuses that var unless THROWAWAY=1 and the site is not live
 *   (deploy/conformance.sh). Without the constant this file returns at once and the plugins are never read.
 *
 *   The plugins are upstream files, byte for byte (spikes/b2-wordpress/conformance/PINS, checked by
 *   tests/conformance-pins-test.sh):
 *   - basic-auth.php: JSON Basic Authentication (WP-API/Basic-Auth). The suites send the admin's login
 *     password over HTTP Basic auth, which stock WordPress accepts only for application passwords.
 *   - woocommerce-e2e-test-helper.php: REST routes to set and delete options, feature flags and the theme.
 *   - woocommerce-cleanup.php: GET wc-cleanup/v1/reset, which deletes the store's orders, products, coupons,
 *     terms and media, and truncates the tax and analytics tables.
 */
if ( ! defined( 'SKYPHUSION_CONFORMANCE' ) || true !== SKYPHUSION_CONFORMANCE ) {
	return;
}
foreach ( array( 'basic-auth.php', 'woocommerce-e2e-test-helper.php', 'woocommerce-cleanup.php' ) as $skyphusion_conformance_file ) {
	require_once WP_CONTENT_DIR . '/conformance/' . $skyphusion_conformance_file;
}
