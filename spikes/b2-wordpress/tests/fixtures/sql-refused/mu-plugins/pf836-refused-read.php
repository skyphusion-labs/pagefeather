<?php
/**
 * Plugin Name: #836 test fixture: a refused read (TEST BUILDS ONLY)
 * Imported only by tests/sql-refused-e2e.sh (IMPORT_CONTENT=tests/fixtures/sql-refused
 * IMPORT_MU_PLUGINS=pf836-refused-read.php); never part of a site build. It answers only a request carrying the spike
 * token. GET /?pf836=<refused|short|missing>: runs one read the way a plugin would, then answers JSON.
 *   refused: a LIKE over the 50-byte cap with a '%' inside (the dialect leaves it; the platform SQLite refuses it);
 *   short:   the same query shape under the cap (SQLite runs it);
 *   missing: a SELECT from a table that does not exist (MySQL raises that too: wpdb's path, not a refusal).
 */
add_action(
	'init',
	static function () {
		if ( ! isset( $_GET['pf836'] ) ) {
			return;
		}
		$token = getenv( 'SPIKE_TOKEN' ) ?: ( defined( 'SPIKE_TOKEN' ) ? SPIKE_TOKEN : '' );
		$given = isset( $_SERVER['HTTP_X_SPIKE_TOKEN'] ) ? (string) $_SERVER['HTTP_X_SPIKE_TOKEN'] : '';
		if ( '' === $given || ( '' !== $token && ! hash_equals( $token, $given ) ) ) {
			return;
		}
		global $wpdb;
		$shape = (string) $_GET['pf836'];
		if ( 'missing' === $shape ) {
			$found = $wpdb->get_var( "SELECT 1 FROM {$wpdb->prefix}pf836_nope LIMIT 1" );
		} else {
			$tail  = 'refused' === $shape ? str_repeat( 'b', 60 ) : 'b';
			$found = $wpdb->get_var( "SELECT COUNT(*) FROM $wpdb->posts WHERE post_content LIKE '%a%" . $tail . "%'" );
		}
		wp_send_json( array( 'found' => $found, 'error' => $wpdb->last_error ) );
	}
);
