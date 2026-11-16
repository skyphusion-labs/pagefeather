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

/*
 * Why a purge was asked (#704): a hook and a NAME only, never a value. An ordinary checkout asked
 * about one purge per order on pf628 (2026-11-15), and every sent purge empties every cached page of
 * the site, from the account's 5 purges a minute (#699). The Worker logs each reason as m: purge-why.
 */
function skyphusion_edge_cache_reason( $hook, $args ) {
	$a = array_values( (array) $args );
	$d = '';
	switch ( $hook ) {
		case 'updated_option':
			$d = isset( $a[0] ) && is_string( $a[0] ) ? $a[0] : '';
			break;
		case 'clean_post_cache':
			$d = isset( $a[0] ) ? (string) get_post_type( $a[0] ) : '';
			break;
		case 'clean_term_cache':
			$d = isset( $a[1] ) && is_string( $a[1] ) ? $a[1] : '';
			break;
		case 'clean_comment_cache':
			$ids = isset( $a[0] ) ? (array) $a[0] : array();
			$c   = $ids ? get_comment( reset( $ids ) ) : null;
			$d   = $c && isset( $c->comment_type ) ? (string) $c->comment_type : '';
			break;
		case 'woocommerce_product_set_stock_status':
		case 'woocommerce_variation_set_stock_status':
			$d = isset( $a[1] ) && is_string( $a[1] ) ? $a[1] : '';
			break;
	}
	$r = '' === $d ? (string) $hook : $hook . ':' . $d;
	return substr( preg_replace( '/[^A-Za-z0-9_:.-]/', '_', $r ), 0, 120 );
}

function skyphusion_edge_cache_purge() {
	static $seen = array();
	$args = func_get_args();
	// Which hook asked, for measurement.
	do_action( 'skyphusion_edge_cache_purge_request', current_filter(), $args, ! empty( $seen ) );
	// The first reason asks the purge, as before. Each NEW reason in the request is sent too, so the
	// Worker can log every distinct cause (#704); a repeat sends nothing.
	$why = skyphusion_edge_cache_reason( current_filter(), $args );
	if ( isset( $seen[ $why ] ) ) {
		return;
	}
	$seen[ $why ] = true;
	$reply = post_message_to_js( json_encode( array( 'cache' => 'purge', 'why' => $why ) ) );
	do_action( 'skyphusion_edge_cache_purge_reply', $reply );
}

// 3 accepted arguments, so the reason can name the taxonomy (clean_term_cache) and the status (#704).
foreach ( array( 'clean_term_cache', 'switch_theme', 'customize_save_after', 'wp_update_nav_menu', 'activated_plugin', 'deactivated_plugin' ) as $skyphusion_hook ) {
	add_action( $skyphusion_hook, 'skyphusion_edge_cache_purge', 10, 3 );
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
		// Opening the editor (post-new.php) makes an auto-draft, which is on no page:
		// measured on b (wp-perf-dosql, 2026-11-06), every editor open emptied the
		// page cache (issue #63). Only auto-draft: a draft may be a post that was
		// just unpublished, and that must purge.
		if ( 'auto-draft' === get_post_status( $post_id ) ) {
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
	add_action( $skyphusion_hook, 'skyphusion_edge_cache_purge', 10, 3 );
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

/*
 * #628 C2: mark a WooCommerce product, shop or product-category page for the Worker, which gives it
 * PAGE_CACHE_PRODUCT_TTL at the edge when that flag is set (page-cache-ttl.mjs). These pages show stock.
 * The Worker removes the mark from every answer, so a visitor never sees it.
 */
function skyphusion_edge_cache_is_product_page() {
	if ( ! function_exists( 'is_product' ) || ! function_exists( 'is_shop' ) || ! function_exists( 'is_product_taxonomy' ) ) {
		return false;
	}
	return (bool) ( is_product() || is_shop() || is_product_taxonomy() );
}
add_action(
	'template_redirect',
	function () {
		if ( skyphusion_edge_cache_is_product_page() && ! headers_sent() ) {
			header( 'x-pf-page: product' );
		}
	},
	0
);
