<?php
/**
 * Plugin Name: Edge Cache
 * Description: Purge the Worker's page cache (Workers Cache) when content changes.
 *
 * The Worker marks logged-out pages cacheable with Cache-Tag: wp-pages. Then
 * Cloudflare serves them without running the Worker or PHP. When WordPress
 * changes content, this plugin asks the Worker to purge that tag once, after
 * the request. The cache TTL limits staleness if a purge fails.
 */

if ( ! function_exists( 'post_message_to_js' ) ) {
	return;
}

function skyphusion_edge_cache_purge() {
	static $sent = false;
	// Which hook asked, for measurement (c1 logs it: php/c1-purge-log.php).
	do_action( 'skyphusion_edge_cache_purge_request', current_filter(), func_get_args(), $sent );
	if ( ! $sent ) {
		$sent = true;
		$reply = post_message_to_js( json_encode( array( 'cache' => 'purge' ) ) );
		do_action( 'skyphusion_edge_cache_purge_reply', $reply );
	}
}

foreach ( array( 'clean_term_cache', 'switch_theme', 'customize_save_after', 'wp_update_nav_menu', 'activated_plugin', 'deactivated_plugin' ) as $skyphusion_hook ) {
	add_action( $skyphusion_hook, 'skyphusion_edge_cache_purge' );
}

/*
 * Orders are not on any page. Every WooCommerce checkout cleans the post cache
 * of the order and adds order notes (comments): measured on c1 (2026-11-06), 80
 * checkouts sent 80 purges, and the purge limit is 5 a minute per account. So:
 * - no purge for order post types and order notes;
 * - in an order request (a checkout, or a payment callback), no purge for the
 *   product either: the stock quantity on the page may be up to one page cache
 *   TTL old. A change of stock STATUS (in stock, out of stock) still purges,
 *   so a product that sold out does not stay buyable on a cached page.
 */
function skyphusion_edge_cache_order_request() {
	$route = isset( $_GET['rest_route'] ) ? (string) $_GET['rest_route'] : (string) ( $_SERVER['REQUEST_URI'] ?? '' );
	return false !== strpos( $route, '/wc/store/v1/checkout' ) || ( isset( $_GET['wc-ajax'] ) && 'checkout' === $_GET['wc-ajax'] ) || isset( $_GET['wc-api'] );
}
add_action(
	'clean_post_cache',
	function ( $post_id ) {
		$type = get_post_type( $post_id );
		if ( in_array( $type, array( 'shop_order', 'shop_order_placehold', 'shop_order_refund', 'shop_subscription', 'scheduled-action', 'revision' ), true ) ) {
			return;
		}
		if ( in_array( $type, array( 'product', 'product_variation' ), true ) && skyphusion_edge_cache_order_request() ) {
			return;
		}
		skyphusion_edge_cache_purge( $post_id );
	}
);
add_action(
	'clean_comment_cache',
	function ( $ids ) {
		foreach ( (array) $ids as $id ) {
			$c = get_comment( $id );
			if ( ! $c || 'order_note' !== $c->comment_type ) {
				skyphusion_edge_cache_purge( $id );
				return;
			}
		}
	}
);
foreach ( array( 'woocommerce_product_set_stock_status', 'woocommerce_variation_set_stock_status' ) as $skyphusion_hook ) {
	add_action( $skyphusion_hook, 'skyphusion_edge_cache_purge' );
}

// Site options (title, permalinks, reading settings, widgets) change pages too.
// Transients and cron are options as well; they change on their own, so skip them.
// So are WooCommerce batch processing state and locks: wc_pending_batch_processes
// and wc_batch_* change in checkouts and cron runs, and *.lock / *_lock options are
// locks, and action_scheduler_* is Action Scheduler state (measured on c1 under
// load, 2026-11-06: each emptied the page cache).
add_action(
	'updated_option',
	function ( $name ) {
		if ( ! preg_match( '/^(_transient_|_site_transient_|cron$|rewrite_rules$|recently_activated$|_edit_lock|wc_pending_batch_processes$|wc_batch_|action_scheduler_)|[._]lock$/', $name ) ) {
			skyphusion_edge_cache_purge( $name );
		}
	}
);
