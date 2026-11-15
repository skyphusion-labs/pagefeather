<?php
/**
 * Plugin Name: WooCommerce extras off
 * Description: When WOO_EXTRAS=off, force four WooCommerce options off. Unset
 *   leaves WooCommerce's own defaults. Analytics stays on.
 *
 * The Worker defines SKYPHUSION_WOO_EXTRAS as 'off' from the WOO_EXTRAS var
 * (index.js). Each pre_option_* filter returns "no" before the database is
 * read, so a stored "yes" cannot turn the option back on.
 *
 * Option names from the pinned WooCommerce 11.2.1 (WOO_VERSION in build.sh):
 *   - woocommerce_feature_order_attribution_enabled
 *       FeaturesController::feature_enable_option_name( 'order_attribution' ).
 *       OrderAttributionController::on_init returns when that feature is off,
 *       so the order-attribution script is not printed and checkout does not
 *       save _wc_order_attribution_* meta.
 *   - woocommerce_allow_tracking
 *       WC_Site_Tracking::is_tracking_enabled, and the WooCommerce.com settings.
 *   - woocommerce_show_marketplace_suggestions
 *       RemoteInboxNotifications::TOGGLE_OPTION_NAME.
 *   - woocommerce_feature_remote_logging_enabled
 *       feature_enable_option_name( 'remote_logging' ). No custom option_key.
 *       RemoteLogger::is_remote_logging_allowed checks that feature.
 * Analytics is woocommerce_analytics_enabled (Analytics::TOGGLE_OPTION_NAME).
 * This file does not filter it.
 */

if ( ! defined( 'SKYPHUSION_WOO_EXTRAS' ) || 'off' !== SKYPHUSION_WOO_EXTRAS ) {
	return;
}

// Late, so a normal pre_option callback cannot put the stored value back.
foreach (
	array(
		'woocommerce_feature_order_attribution_enabled',
		'woocommerce_allow_tracking',
		'woocommerce_show_marketplace_suggestions',
		'woocommerce_feature_remote_logging_enabled',
	) as $skyphusion_woo_extra
) {
	add_filter(
		'pre_option_' . $skyphusion_woo_extra,
		static function () {
			return 'no';
		},
		9999
	);
}
