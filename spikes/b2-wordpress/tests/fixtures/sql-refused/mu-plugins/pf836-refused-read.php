<?php
/**
 * Plugin Name: #836 test fixture: a refused read (TEST BUILDS ONLY)
 * Imported only by tests/sql-refused-e2e.sh (IMPORT_CONTENT=tests/fixtures/sql-refused
 * IMPORT_MU_PLUGINS=pf836-refused-read.php); never part of a site build. It answers only a request carrying the spike
 * token. GET /?pf836=<refused|short|missing>: runs one read the way a plugin would, then answers JSON.
 *   refused: a LIKE over the 50-byte cap with a '%' inside (the dialect leaves it; the platform SQLite refuses it);
 *   short:   the same query shape under the cap (SQLite runs it);
 *   missing: a SELECT from a table that does not exist (MySQL raises that too: wpdb's path, not a refusal).
 *   activate-woo: activate_plugin( woocommerce ) in an ordinary request (its install runs the 5 KB cart-page LIKE probe);
 *   create-pages: forget the cart page option, then WC_Install::create_pages() (the same probe); answers the cart page
 *                 id before and after, and how many live pages hold the cart block (one: no duplicate).
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
		if ( 'activate-woo' === $shape ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
			$r = activate_plugin( 'woocommerce/woocommerce.php' );
			delete_transient( '_wc_activation_redirect' );
			wp_send_json( array( 'active' => is_plugin_active( 'woocommerce/woocommerce.php' ), 'error' => is_wp_error( $r ) ? $r->get_error_message() : null, 'db_error' => $wpdb->last_error ) );
		}
		if ( 'create-pages' === $shape ) {
			$before = (int) get_option( 'woocommerce_cart_page_id' );
			update_option( 'woocommerce_cart_page_id', 0 );
			WC_Install::create_pages();
			$after = (int) get_option( 'woocommerce_cart_page_id' );
			$carts = (int) $wpdb->get_var( "SELECT COUNT(*) FROM $wpdb->posts WHERE post_type = 'page' AND post_status = 'publish' AND instr( post_content, '<!-- wp:woocommerce/cart ' ) > 0" );
			wp_send_json( array( 'before' => $before, 'after' => $after, 'carts' => $carts, 'db_error' => $wpdb->last_error ) );
		}
		if ( 'missing' === $shape ) {
			$found = $wpdb->get_var( "SELECT 1 FROM {$wpdb->prefix}pf836_nope LIMIT 1" );
		} else {
			$tail  = 'refused' === $shape ? str_repeat( 'b', 60 ) : 'b';
			$found = $wpdb->get_var( "SELECT COUNT(*) FROM $wpdb->posts WHERE post_content LIKE '%a%" . $tail . "%'" );
		}
		wp_send_json( array( 'found' => $found, 'error' => $wpdb->last_error ) );
	}
);
