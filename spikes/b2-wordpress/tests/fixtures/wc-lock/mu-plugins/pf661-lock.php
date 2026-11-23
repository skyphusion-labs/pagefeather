<?php
/**
 * Plugin Name: #661 test fixture: WooCommerce's install lock (TEST BUILDS ONLY)
 * Imported only by tests/wc-install-lock-e2e.sh (IMPORT_CONTENT=tests/fixtures/wc-lock IMPORT_MU_PLUGINS=pf661-lock.php);
 * never part of a site build. It answers only a request carrying x-oc-off, which index.js deletes before PHP unless
 * the request has a VALID spike token (handle() calls stripOperatorHeaders, operator-headers.mjs); PHP cannot check the
 * token itself. Both answer on plugins_loaded at priority 0, BEFORE init, so WooCommerce's check_version (init,
 * priority 5) does not run in the fixture's own request.
 *   GET /?pf661_plant=<age s>  writes wc_installing = now - age: the lock a first activation that died mid-install leaves.
 *   GET /?pf661=1             reads WooCommerce's install state straight from the table, as JSON.
 */
add_action(
	'plugins_loaded',
	static function () {
		if ( empty( $_SERVER['HTTP_X_OC_OFF'] ) || ( ! isset( $_GET['pf661'] ) && ! isset( $_GET['pf661_plant'] ) ) ) {
			return;
		}
		global $wpdb;
		header( 'content-type: application/json' );
		header( 'cache-control: private, no-store' );
		if ( isset( $_GET['pf661_plant'] ) ) {
			$v = time() - max( 0, (int) $_GET['pf661_plant'] );
			$wpdb->query( "DELETE FROM {$wpdb->options} WHERE option_name = 'wc_installing'" );
			$ok = $wpdb->query( $wpdb->prepare( "INSERT INTO {$wpdb->options} (option_name, option_value, autoload) VALUES ('wc_installing', %d, 'no')", $v ) );
			echo wp_json_encode( array( 'planted' => (bool) $ok, 'value' => $v, 'db_error' => $wpdb->last_error ? $wpdb->last_error : null ) );
			exit;
		}
		$lock  = $wpdb->get_var( "SELECT option_value FROM {$wpdb->options} WHERE option_name = 'wc_installing'" );
		$ver   = $wpdb->get_var( "SELECT option_value FROM {$wpdb->options} WHERE option_name = 'woocommerce_version'" );
		$roles = maybe_unserialize( $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $wpdb->prefix . 'user_roles' ) ) );
		$caps  = ( is_array( $roles ) && isset( $roles['administrator']['capabilities'] ) ) ? $roles['administrator']['capabilities'] : array();
		echo wp_json_encode(
			array(
				'code_version'       => defined( 'WC_VERSION' ) ? WC_VERSION : null,
				'db_version'         => null === $ver ? null : (string) $ver,
				'lock'               => null === $lock ? null : (int) $lock,
				'edit_products'      => ! empty( $caps['edit_products'] ),
				'manage_woocommerce' => ! empty( $caps['manage_woocommerce'] ),
				'customer_role'      => is_array( $roles ) && isset( $roles['customer'] ),
				'db_error'           => $wpdb->last_error ? $wpdb->last_error : null,
			)
		);
		exit;
	},
	0
);
