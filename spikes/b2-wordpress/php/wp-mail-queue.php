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

if ( ! function_exists( 'wp_mail' ) ) {
	function wp_mail( $to, $subject, $message, $headers = '', $attachments = array() ) {
		$payload = array(
			'email' => array(
				'to'          => array_values( (array) $to ),
				'subject'     => (string) $subject,
				'message'     => is_array( $message ) ? wp_json_encode( $message ) : (string) $message,
				'headers'     => is_array( $headers ) ? array_values( $headers ) : (string) $headers,
				'attachments' => $attachments ? array_values( (array) $attachments ) : array(),
			),
		);
		// Hand off to the Worker and return success: the Worker records/enqueues the
		// message so WordPress (and the checkout request) does not wait on the send.
		post_message_to_js( wp_json_encode( $payload ) );
		return true;
	}
}
