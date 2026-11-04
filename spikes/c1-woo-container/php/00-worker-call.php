<?php
/**
 * Plugin Name: Worker call
 * Description: One message to the Worker (R2, Images, cache purge) through the Container outbound handler at http://worker.internal/.
 *
 * Loaded first (00-), so the R2 Uploads and Edge Cache mu-plugins find it. The
 * Worker holds the bindings; the container holds no keys for them.
 */
if ( ! function_exists( 'skyphusion_worker_call' ) ) {
	function skyphusion_worker_call( $json ) {
		static $ch = null;
		if ( null === $ch ) {
			$ch = curl_init( 'http://worker.internal/' );
			curl_setopt_array(
				$ch,
				array(
					CURLOPT_POST           => true,
					CURLOPT_RETURNTRANSFER => true,
					CURLOPT_HTTPHEADER     => array( 'Content-Type: application/json' ),
					CURLOPT_TIMEOUT        => 60,
				)
			);
		}
		curl_setopt( $ch, CURLOPT_POSTFIELDS, $json );
		$reply = curl_exec( $ch );
		return false === $reply ? '' : $reply;
	}
}
// Edge Cache checks for post_message_to_js; give it the same entry point.
if ( ! function_exists( 'post_message_to_js' ) ) {
	function post_message_to_js( $json ) {
		return skyphusion_worker_call( $json );
	}
}
