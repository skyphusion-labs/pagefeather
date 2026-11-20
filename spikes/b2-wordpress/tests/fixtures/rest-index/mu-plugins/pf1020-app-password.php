<?php
/**
 * Plugin Name: #1020 test fixture: an admin application password (TEST BUILDS ONLY)
 * Imported only by tests/rest-index-cache-e2e.sh; never part of a site build. Local http has no TLS, so application
 * passwords are allowed here (test builds only). GET /?pf1020=app-password with the spike token makes one for the
 * admin and answers {"user":..., "password":...}. ?pf1020=activate-hello and ?pf1020=deactivate-hello switch Hello Dolly
 * with activate_plugin and deactivate_plugins, as wp-admin's Plugins screen does.
 */
add_filter( 'wp_is_application_passwords_available', '__return_true' );
add_action(
	'init',
	static function () {
		if ( ! isset( $_GET['pf1020'] ) ) {
			return;
		}
		$token = getenv( 'SPIKE_TOKEN' ) ?: ( defined( 'SPIKE_TOKEN' ) ? SPIKE_TOKEN : '' );
		$given = isset( $_SERVER['HTTP_X_SPIKE_TOKEN'] ) ? (string) $_SERVER['HTTP_X_SPIKE_TOKEN'] : '';
		if ( '' === $given || ( '' !== $token && ! hash_equals( $token, $given ) ) ) {
			return;
		}
		if ( 'activate-hello' === $_GET['pf1020'] || 'deactivate-hello' === $_GET['pf1020'] ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
			$r = 'activate-hello' === $_GET['pf1020'] ? activate_plugin( 'hello.php' ) : deactivate_plugins( 'hello.php' );
			wp_send_json( array( 'active' => is_plugin_active( 'hello.php' ), 'error' => is_wp_error( $r ) ? $r->get_error_message() : null ) );
		}
		if ( 'app-password' !== $_GET['pf1020'] ) {
			return;
		}
		$user = get_user_by( 'login', 'admin' );
		$made = WP_Application_Passwords::create_new_application_password( $user->ID, array( 'name' => 'pf1020-' . wp_generate_password( 6, false ) ) );
		wp_send_json( array( 'user' => 'admin', 'password' => is_wp_error( $made ) ? null : $made[0] ) );
	}
);
