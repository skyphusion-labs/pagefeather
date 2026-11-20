<?php
/**
 * Plugin Name: #1060 test fixture: a PHP run that stalls (TEST BUILDS ONLY)
 * Imported only by tests/stale-lock-e2e.sh; never part of a site build. With the spike token:
 *   ?pf1060=hang&port=N  wp_remote_get to 127.0.0.1:N (a local server that never answers): one bridge message, then
 *                        a wait with no progress, the way a stuck run looks to the PHP lock.
 *   ?pf1060=ok           answers at once.
 */
add_action(
	'init',
	static function () {
		if ( ! isset( $_GET['pf1060'] ) ) {
			return;
		}
		$token = getenv( 'SPIKE_TOKEN' ) ?: ( defined( 'SPIKE_TOKEN' ) ? SPIKE_TOKEN : '' );
		$given = isset( $_SERVER['HTTP_X_SPIKE_TOKEN'] ) ? (string) $_SERVER['HTTP_X_SPIKE_TOKEN'] : '';
		if ( '' === $given || ( '' !== $token && ! hash_equals( $token, $given ) ) ) {
			return;
		}
		if ( 'hang' === $_GET['pf1060'] ) {
			$port = isset( $_GET['port'] ) ? (int) $_GET['port'] : 0;
			$r    = wp_remote_get( 'http://127.0.0.1:' . $port . '/', array( 'timeout' => 150 ) );
			wp_send_json( array( 'hang' => 'done', 'error' => is_wp_error( $r ) ? $r->get_error_message() : null ) );
		}
		wp_send_json( array( 'ok' => true ) );
	}
);
