<?php
/**
 * Plugin Name: Async email via the Worker (b-dosql)
 * Description: Overrides wp_mail to hand the message to the Worker through the
 *   post_message_to_js bridge instead of PHP mail(), which has no transport in the
 *   isolate (WooCommerce order emails otherwise fail silently). The Worker records
 *   the message and, once the send leg lands (a Queue producer or ctx.waitUntil to
 *   Cloudflare Email Service, pending the WfP queue-binding decision and a verified
 *   sender domain), a consumer sends it. Checkout never blocks on email.
 *   b-dosql only (SKYPHUSION_ASYNC_EMAIL); ASYNC_EMAIL=off disables it.
 *
 * wp_mail is a pluggable function: a mu-plugin defines it before wp-includes/
 * pluggable.php, so this replaces core's transport.
 */

if ( ! defined( 'SKYPHUSION_ASYNC_EMAIL' ) || ! SKYPHUSION_ASYNC_EMAIL || ! function_exists( 'post_message_to_js' ) ) {
	return;
}

// The Action Scheduler action that is running, so a message carries it (#362, email-handoff.mjs).
// begin_execute fires before log_execution sets the action in-progress; when that write fails,
// log_execution throws and the action never runs, so no mail goes out under its id. A mail sent
// while this is set therefore comes from an action whose in-progress write landed.
$GLOBALS['skyphusion_mail_as_action'] = 0;
add_action( 'action_scheduler_begin_execute', function ( $action_id ) { $GLOBALS['skyphusion_mail_as_action'] = (int) $action_id; }, 0, 1 );
foreach ( array( 'action_scheduler_after_execute', 'action_scheduler_failed_execution', 'action_scheduler_failed_validation', 'action_scheduler_execution_ignored' ) as $skyphusion_mail_hook ) {
	add_action( $skyphusion_mail_hook, function () { $GLOBALS['skyphusion_mail_as_action'] = 0; }, PHP_INT_MAX, 0 );
}
unset( $skyphusion_mail_hook );

if ( ! function_exists( 'wp_mail' ) ) {
	function wp_mail( $to, $subject, $message, $headers = '', $attachments = array() ) {
		$payload = array(
			'email' => array(
				'to'          => array_values( (array) $to ),
				'subject'     => (string) $subject,
				'message'     => is_array( $message ) ? wp_json_encode( $message ) : (string) $message,
				'headers'     => is_array( $headers ) ? array_values( $headers ) : (string) $headers,
				'attachments' => $attachments ? array_values( (array) $attachments ) : array(),
				// The dedupe key for an order email (#362): the action it was sent from, or 0.
				'as_action'   => isset( $GLOBALS['skyphusion_mail_as_action'] ) ? (int) $GLOBALS['skyphusion_mail_as_action'] : 0,
				// From a cron tick WP-Cron event: 1 its unschedule was saved, -1 it was not, 0 not an event.
				'wp_cron'     => isset( $GLOBALS['skyphusion_mail_wp_cron'] ) ? (int) $GLOBALS['skyphusion_mail_wp_cron'] : 0,
			),
		);
		// Hand off to the Worker and return success. On a request the Worker records the message
		// and sends it after the response, so checkout does not wait. In a cron tick the Worker
		// hands it to the durable path before this returns (#362, email-handoff.mjs).
		post_message_to_js( wp_json_encode( $payload ) );
		return true;
	}
}
