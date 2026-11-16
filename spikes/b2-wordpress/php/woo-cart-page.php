<?php
/**
 * Plugin Name: WooCommerce cart page, found on SQLite
 * Description: WooCommerce finds the store's existing cart page instead of making a second one (#744).
 *
 * WooCommerce's wc_create_page (Status > Tools > "Create default WooCommerce pages", a first install, one database
 * update routine) looks for an existing cart page with post_content LIKE '%<the whole cart page>%'. The pattern is
 * about 5 KB, and SQLite refuses it ("LIKE or GLOB pattern too complex"; this SQLite passes the 4.2 KB checkout
 * pattern and fails the 5.1 KB cart one, measured locally 2026-11-16). The probe then finds nothing, so WooCommerce
 * made a second Cart page whenever the cart option was stale (a restore, an import), and left a trashed cart page
 * in the trash while it made a new one.
 *
 * This answers WooCommerce's own filter, woocommerce_create_page_id, which it applies after that probe, for the cart
 * only (the content decides: the cart block's opening marker, so a translated slug still counts):
 *   - WooCommerce found a page: kept as is;
 *   - else the oldest live page with the cart block's opening marker (a short LIKE, about 25 characters);
 *   - else the oldest trashed one, restored as WooCommerce restores a trashed page (wp_update_post, publish);
 *   - else nothing, and WooCommerce makes the page as before.
 * Checkout, My account and Shop are not touched: their probes work (measured).
 * Test: tests/woo-cart-page-test.php.
 */

add_filter(
	'woocommerce_create_page_id',
	static function ( $found, $slug, $page_content ) {
		$marker = '<!-- wp:woocommerce/cart ';
		if ( $found || false === strpos( (string) $page_content, $marker ) ) {
			return $found;
		}
		global $wpdb;
		$like = '%' . $wpdb->esc_like( $marker ) . '%';
		$live = $wpdb->get_var( $wpdb->prepare( "SELECT ID FROM $wpdb->posts WHERE post_type = 'page' AND post_status NOT IN ( 'pending', 'trash', 'future', 'auto-draft' ) AND post_content LIKE %s ORDER BY ID ASC LIMIT 1", $like ) );
		if ( $live ) {
			return (int) $live;
		}
		$trashed = $wpdb->get_var( $wpdb->prepare( "SELECT ID FROM $wpdb->posts WHERE post_type = 'page' AND post_status = 'trash' AND post_content LIKE %s ORDER BY ID ASC LIMIT 1", $like ) );
		if ( $trashed ) {
			wp_update_post( array( 'ID' => (int) $trashed, 'post_status' => 'publish' ) );
			return (int) $trashed;
		}
		return $found;
	},
	10,
	3
);
