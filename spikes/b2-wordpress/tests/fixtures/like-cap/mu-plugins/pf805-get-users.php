<?php
/**
 * Plugin Name: #805 test fixture: get_users() with a long search (TEST BUILDS ONLY)
 * Imported only by tests/like-cap-e2e.sh and #805's edge proof (IMPORT_CONTENT=tests/fixtures/like-cap
 * IMPORT_MU_PLUGINS=pf805-get-users.php); never part of a site build. It answers only a request carrying the spike
 * token. GET /?pf805_users=<search>&shape=<exact|prefix|both>: makes sure a user with a 56-character login exists, then
 * runs get_users() the way a plugin would, and answers JSON: how many users were found, and $wpdb->last_error.
 *   exact:  the search as given, no '*' (an exact `user_login LIKE 'login'`: over the 50-byte cap, #805);
 *   prefix: the search followed by '*' (`LIKE 'login%'`);
 *   both:   '*' on both sides (`LIKE '%login%'`, which d1-dialect already rewrote before #805).
 */
add_action(
	'init',
	static function () {
		if ( ! isset( $_GET['pf805_users'] ) ) {
			return;
		}
		$token = getenv( 'SPIKE_TOKEN' ) ?: ( defined( 'SPIKE_TOKEN' ) ? SPIKE_TOKEN : '' );
		$given = isset( $_SERVER['HTTP_X_SPIKE_TOKEN'] ) ? (string) $_SERVER['HTTP_X_SPIKE_TOKEN'] : '';
		if ( '' === $given || ( '' !== $token && ! hash_equals( $token, $given ) ) ) {
			return;
		}
		global $wpdb;
		$login = 'pf805-' . str_repeat( 'x', 50 ); // 56 characters
		if ( ! username_exists( $login ) ) {
			wp_insert_user( array( 'user_login' => $login, 'user_pass' => wp_generate_password( 24 ), 'user_email' => 'pf805@example.com' ) );
		}
		$search = wp_unslash( (string) $_GET['pf805_users'] );
		$shape  = isset( $_GET['shape'] ) ? (string) $_GET['shape'] : 'exact';
		if ( 'prefix' === $shape ) {
			$search .= '*';
		} elseif ( 'both' === $shape ) {
			$search = '*' . $search . '*';
		}
		$wpdb->suppress_errors( true ); // so the answer is JSON; the error is still read from last_error
		$wpdb->last_error = '';
		$found            = get_users( array( 'search' => $search, 'search_columns' => array( 'user_login' ), 'fields' => 'ID' ) );
		header( 'content-type: application/json' );
		echo wp_json_encode( array( 'shape' => $shape, 'search_len' => strlen( $search ), 'found' => count( $found ), 'error' => (string) $wpdb->last_error ) );
		exit;
	},
	0
);
