<?php
/**
 * Plugin Name: WooCommerce on the edge
 * Description: WooCommerce settings for PHP in a Worker.
 *
 * PHP in a Worker cannot send mail (no mail(), no network). Rendering the order
 * emails at checkout loads PHPMailer and the email templates for nothing, in a
 * request that is near the 128 MB isolate memory limit. Defer them to Action
 * Scheduler, where a mail binding can send them later.
 */
add_filter( 'woocommerce_defer_transactional_emails', '__return_true' );

/*
 * WooCommerce bumps its cache "transient versions" on every order change: 33
 * writes of _transient_orders-transient-version in one checkout (measured
 * 2026-11-04), each 3 to 4 D1 round trips. In a request, keep the newest value
 * in the object cache (so WordPress reads it) and write it to the database once,
 * at the end of the request.
 */
$GLOBALS['skyphusion_deferred_options'] = array();
add_filter(
	'pre_update_option',
	function ( $value, $option, $old_value ) {
		if ( ! preg_match( '/^_transient_[a-z_]+-transient-version$/', $option ) || $value === $old_value ) {
			return $value;
		}
		$GLOBALS['skyphusion_deferred_options'][ $option ] = $value;
		$alloptions = wp_load_alloptions();
		if ( isset( $alloptions[ $option ] ) ) {
			$alloptions[ $option ] = $value;
			wp_cache_set( 'alloptions', $alloptions, 'options' );
		} else {
			wp_cache_set( $option, $value, 'options' );
		}
		return $old_value; // core sees no change and writes nothing now
	},
	10,
	3
);
register_shutdown_function(
	function () {
		global $wpdb;
		foreach ( $GLOBALS['skyphusion_deferred_options'] as $option => $value ) {
			$wpdb->update( $wpdb->options, array( 'option_value' => maybe_serialize( $value ) ), array( 'option_name' => $option ) );
		}
	}
);

/*
 * #969: tell the Worker that this request stored a deferred Woo email.
 * The Worker wakes the alarm soon. The mail log row can land inside the
 * conformance poll. The filter runs when the action is stored. The shutdown
 * hook is after Action Scheduler's dispatch (priority 100).
 */
// #1215: at ENQUEUE. It listened on action_scheduler_stored_action_instance, which Action Scheduler applies when it
// LOADS an action from the store (get_stored_action, from fetch_action), never when it stores one, so a checkout
// never sent emailDue. WC()->queue()->add() is as_schedule_single_action( time(), ... ), whose pre_ filter runs at
// enqueue with the hook; an async enqueue is covered too. The filters pass $pre through untouched, and mark only an
// enqueue no other filter short-circuited, of an email due now (an action scheduled ahead is the tick's).
function skyphusion_email_enqueue_mark( $pre, $hook, $timestamp = null ) {
	if ( null === $pre && 'woocommerce_send_queued_transactional_email' === $hook && ( null === $timestamp || (int) $timestamp <= time() + 60 ) ) {
		$GLOBALS['skyphusion_email_action_stored'] = 1;
	}
	return $pre;
}
add_filter(
	'pre_as_schedule_single_action',
	function ( $pre, $timestamp, $hook ) {
		return skyphusion_email_enqueue_mark( $pre, $hook, $timestamp );
	},
	PHP_INT_MAX,
	3
);
add_filter(
	'pre_as_enqueue_async_action',
	function ( $pre, $hook ) {
		return skyphusion_email_enqueue_mark( $pre, $hook );
	},
	PHP_INT_MAX,
	2
);
add_action(
	'shutdown',
	function () {
		if ( empty( $GLOBALS['skyphusion_email_action_stored'] ) || ! function_exists( 'post_message_to_js' ) ) {
			return;
		}
		post_message_to_js( wp_json_encode( array( 'emailDue' => 1 ) ) );
	},
	120
);
