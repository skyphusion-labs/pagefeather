<?php
/**
 * Plugin Name: WooCommerce cron schedules before init
 * Description: Keeps WooCommerce's translated cron schedule names off the first
 *   request, so a login on that request can set its test cookie (#600).
 *
 * WooCommerce registers cron_schedules from WC_Install::init() as the plugin
 * file loads. The callback translates "Monthly" and "Every 15 Days". On the
 * first request where WooCommerce is active, Jetpack Connection (started from
 * WooCommerce on plugins_loaded, before after_setup_theme) schedules
 * jetpack_clean_nonces, because that event is not stored yet. wp_schedule_event()
 * calls wp_get_schedules(), the translation runs too early, and the notice is
 * printed before the headers. wp-login.php then cannot set wordpress_test_cookie.
 * Later requests find the event and do not schedule it, so they stay quiet.
 *
 * Until init, the same two schedules are registered with plain display strings.
 * wp_schedule_event() only reads the interval. On init, after after_setup_theme,
 * WooCommerce's own callback is put back so the names can be translated.
 *
 * Intervals match WC_Install::cron_schedules in WooCommerce 11.2.1.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Monthly and fifteen-day schedules, without loading the woocommerce textdomain.
 *
 * @param array $schedules Registered cron schedules.
 * @return array
 */
function skyphusion_wc_cron_schedules_plain( $schedules ) {
	$schedules['monthly']     = array(
		'interval' => MONTH_IN_SECONDS,
		'display'  => 'Monthly',
	);
	$schedules['fifteendays'] = array(
		'interval' => 15 * DAY_IN_SECONDS,
		'display'  => 'Every 15 Days',
	);
	return $schedules;
}

add_action(
	'plugin_loaded',
	static function ( $plugin ) {
		if ( 'woocommerce/woocommerce.php' !== plugin_basename( $plugin ) ) {
			return;
		}
		if ( ! has_filter( 'cron_schedules', array( 'WC_Install', 'cron_schedules' ) ) ) {
			return;
		}
		remove_filter( 'cron_schedules', array( 'WC_Install', 'cron_schedules' ) );
		add_filter( 'cron_schedules', 'skyphusion_wc_cron_schedules_plain' );
		add_action(
			'init',
			static function () {
				remove_filter( 'cron_schedules', 'skyphusion_wc_cron_schedules_plain' );
				add_filter( 'cron_schedules', array( 'WC_Install', 'cron_schedules' ) );
			},
			0
		);
	}
);
