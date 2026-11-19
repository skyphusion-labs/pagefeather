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

/**
 * A stored shop, cart, checkout, or my-account id can point at a deleted post (#936).
 * WooCommerce then sends /checkout/ and /cart/ to the home page.
 * This asks WooCommerce to create the missing page.
 * A healthy store compares an autoloaded stamp and does not read the posts.
 * A failed create waits one minute, then tries again.
 * Trashing or deleting one of the four pages clears the stamp.
 */

if ( ! function_exists( 'skyphusion_wc_page_is_live' ) ) {
	/** True when the row is a published page. */
	function skyphusion_wc_page_is_live( $post ) {
		if ( ! is_object( $post ) ) {
			return false;
		}
		$type   = isset( $post->post_type ) ? (string) $post->post_type : '';
		$status = isset( $post->post_status ) ? (string) $post->post_status : '';
		return 'page' === $type && 'publish' === $status;
	}
}

if ( ! function_exists( 'skyphusion_wc_pages_stamp_matches' ) ) {
	/** True when the stored stamp is the same four page ids, in shop, cart, checkout, my-account order. */
	function skyphusion_wc_pages_stamp_matches( $stamp, $ids ) {
		$parts = array();
		foreach ( $ids as $id ) {
			$parts[] = (string) (int) $id;
		}
		return (string) $stamp === implode( ',', $parts );
	}
}

if ( ! function_exists( 'skyphusion_wc_store_page_ids' ) ) {
	/** The four WooCommerce page ids. A missing option is -1. */
	function skyphusion_wc_store_page_ids() {
		$ids = array();
		foreach ( array( 'shop', 'cart', 'checkout', 'myaccount' ) as $key ) {
			$ids[] = (int) wc_get_page_id( $key );
		}
		return $ids;
	}
}

if ( ! function_exists( 'skyphusion_wc_store_pages_missing' ) ) {
	/** True when any of the four ids is not a published page. */
	function skyphusion_wc_store_pages_missing( $ids ) {
		foreach ( $ids as $id ) {
			$post = (int) $id > 0 ? get_post( (int) $id ) : null;
			if ( ! skyphusion_wc_page_is_live( $post ) ) {
				return true;
			}
		}
		return false;
	}
}

if ( ! function_exists( 'skyphusion_wc_pages_repair' ) ) {
	/** Create missing WooCommerce pages, then remember the ids. */
	function skyphusion_wc_pages_repair() {
		if ( ! class_exists( 'WC_Install' ) || ! function_exists( 'wc_get_page_id' ) ) {
			return;
		}
		$ids = skyphusion_wc_store_page_ids();
		if ( skyphusion_wc_pages_stamp_matches( get_option( 'skyphusion_wc_pages_stamp' ), $ids ) ) {
			return;
		}
		if ( get_transient( 'skyphusion_wc_pages_retry' ) ) {
			return;
		}
		if ( skyphusion_wc_store_pages_missing( $ids ) ) {
			WC_Install::create_pages();
			$ids = skyphusion_wc_store_page_ids();
			if ( skyphusion_wc_store_pages_missing( $ids ) ) {
				set_transient( 'skyphusion_wc_pages_retry', '1', MINUTE_IN_SECONDS );
				return;
			}
		}
		delete_transient( 'skyphusion_wc_pages_retry' );
		update_option( 'skyphusion_wc_pages_stamp', implode( ',', array_map( 'strval', array_map( 'intval', $ids ) ) ), true );
	}
}

if ( ! function_exists( 'skyphusion_wc_pages_forget' ) ) {
	/** Drop the stamp when one of the four pages is trashed or deleted. */
	function skyphusion_wc_pages_forget( $post_id ) {
		$stamp = (string) get_option( 'skyphusion_wc_pages_stamp' );
		if ( '' === $stamp ) {
			return;
		}
		$ids = array_map( 'intval', explode( ',', $stamp ) );
		if ( ! in_array( (int) $post_id, $ids, true ) ) {
			return;
		}
		delete_option( 'skyphusion_wc_pages_stamp' );
		delete_transient( 'skyphusion_wc_pages_retry' );
	}
}

if ( function_exists( 'add_action' ) ) {
	add_action( 'init', 'skyphusion_wc_pages_repair', 20 );
	add_action( 'before_delete_post', 'skyphusion_wc_pages_forget' );
	add_action( 'wp_trash_post', 'skyphusion_wc_pages_forget' );
}
