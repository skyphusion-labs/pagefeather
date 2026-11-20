<?php
// php spikes/b2-wordpress/tests/woo-cart-page-test.php [path/to/woo-cart-page.php]   (#744)
//
// WooCommerce's wc_create_page probes for an existing cart page with post_content LIKE '%<the whole cart page>%'
// (about 5 KB), which SQLite refuses ("LIKE or GLOB pattern too complex"), so the probe finds nothing and WooCommerce
// makes a second Cart page (and leaves a trashed one in the trash). The must-use plugin answers WooCommerce's own
// filter, woocommerce_create_page_id, for the cart only: an existing published page with the cart block's opening
// marker, else a trashed one restored as WooCommerce restores it, else nothing (WooCommerce makes the page).
$GLOBALS['filters'] = array();
function add_filter( $tag, $cb, $prio = 10, $args = 1 ) { $GLOBALS['filters'][] = array( $tag, $cb, $prio, $args ); return true; }
$GLOBALS['updated'] = array();
function wp_update_post( $data ) { $GLOBALS['updated'][] = $data; return $data['ID']; }
class FakeWpdb {
	public $posts = 'wp_posts';
	public $queries = array();
	public $answers = array();
	function esc_like( $t ) { return addcslashes( $t, '_%\\' ); }
	function prepare( $q, ...$a ) { foreach ( $a as $v ) { $q = preg_replace( '/%s/', "'" . $v . "'", $q, 1 ); } return $q; }
	function get_var( $q ) { $this->queries[] = $q; return array_shift( $this->answers ); }
}
$GLOBALS['wpdb'] = new FakeWpdb();
$plugin = isset( $argv[1] ) ? $argv[1] : __DIR__ . '/../php/woo-cart-page.php';
$fail = 0;
function check( $label, $cond ) { global $fail; echo ( $cond ? 'ok   ' : 'FAIL ' ) . $label . "\n"; $fail += $cond ? 0 : 1; }
( function () use ( $plugin ) { include $plugin; } )();
$mine = array_values( array_filter( $GLOBALS['filters'], function ( $f ) { return 'woocommerce_create_page_id' === $f[0]; } ) );
check( 'one filter on woocommerce_create_page_id, with its three arguments', 1 === count( $mine ) && 3 === $mine[0][3] );
check( 'no other hook', count( $GLOBALS['filters'] ) === 1 );
$f = isset( $mine[0] ) ? $mine[0][1] : function () { return 'missing'; };
$CART = "<!-- wp:woocommerce/cart -->\n<div class=\"wp-block-woocommerce-cart alignwide is-loading\"><!-- wp:woocommerce/filled-cart-block -->" . str_repeat( 'x', 5000 );
$CHECKOUT = "<!-- wp:woocommerce/checkout -->\n<div class=\"wp-block-woocommerce-checkout\">" . str_repeat( 'y', 4000 );
$w = $GLOBALS['wpdb'];
$reset = function ( $answers ) use ( $w ) { $w->queries = array(); $w->answers = $answers; $GLOBALS['updated'] = array(); };

$reset( array() );
check( 'WooCommerce already found a page: returned as is, no query', 42 === $f( 42, 'cart', $CART ) && 0 === count( $w->queries ) );
$reset( array() );
check( 'not the cart (checkout content): untouched, no query', null === $f( null, 'checkout', $CHECKOUT ) && 0 === count( $w->queries ) );
$reset( array() );
check( 'not the cart (empty content, the shop): untouched, no query', null === $f( null, 'shop', '' ) && 0 === count( $w->queries ) );
$reset( array( '6' ) );
check( 'the cart, a published page with the marker: its id', 6 === $f( null, 'cart', $CART ) && array() === $GLOBALS['updated'] );
$q = isset( $w->queries[0] ) ? $w->queries[0] : '';
check( '  the query is the SHORT marker, never the whole content (under 100 characters of pattern)', false !== strpos( $q, "LIKE '%<!-- wp:woocommerce/cart %'" ) && strlen( $q ) < 400 );
check( '  it asks for a live page (not pending, trash, future, auto-draft), the oldest first', false !== strpos( $q, "post_status NOT IN ( 'pending', 'trash', 'future', 'auto-draft' )" ) && false !== strpos( $q, 'ORDER BY ID ASC' ) );
$reset( array( null, '9' ) );
check( 'no published cart page, a trashed one: restored and its id returned', 9 === $f( null, 'cart', $CART ) );
check( '  restored as WooCommerce restores it (wp_update_post, post_status publish)', array( array( 'ID' => 9, 'post_status' => 'publish' ) ) === $GLOBALS['updated'] );
check( '  the second query is the trash, by the same short marker', isset( $w->queries[1] ) && false !== strpos( $w->queries[1], "post_status = 'trash'" ) && false !== strpos( $w->queries[1], "LIKE '%<!-- wp:woocommerce/cart %'" ) );
$reset( array( null, null ) );
check( 'no cart page at all: the original answer (WooCommerce makes the page)', null === $f( null, 'cart', $CART ) && array() === $GLOBALS['updated'] );
$reset( array() );
check( 'a translated slug still counts as the cart (the content decides)', null === $f( null, 'panier', '' ) && 0 === count( $w->queries ) );
$reset( array( '6' ) );
check( '  and a cart page with a translated slug is found by its content', 6 === $f( null, 'panier', $CART ) );
// #1006: a store page counts as missing only as WooCommerce 11.2.1 wc_create_page counts it: an id above 0
// whose post is gone, not a page, or pending, trash, future or auto-draft. 0 and -1 are the merchant's "none".
$GLOBALS['posts'] = array();
function get_post( $id ) { return isset( $GLOBALS['posts'][ (int) $id ] ) ? $GLOBALS['posts'][ (int) $id ] : null; }
$page = function ( $type, $status ) { $p = new stdClass(); $p->post_type = $type; $p->post_status = $status; return $p; };
check( 'a published page is a valid store page', skyphusion_wc_page_is_valid( $page( 'page', 'publish' ) ) );
check( 'a private page is a valid store page (WooCommerce keeps it)', skyphusion_wc_page_is_valid( $page( 'page', 'private' ) ) );
check( 'a draft page is a valid store page (WooCommerce keeps it)', skyphusion_wc_page_is_valid( $page( 'page', 'draft' ) ) );
foreach ( array( 'pending', 'trash', 'future', 'auto-draft' ) as $st ) {
	check( "a $st page is not a valid store page", ! skyphusion_wc_page_is_valid( $page( 'page', $st ) ) );
}
check( 'a missing post is not a valid store page', ! skyphusion_wc_page_is_valid( null ) );
check( 'a published post is not a valid store page', ! skyphusion_wc_page_is_valid( $page( 'post', 'publish' ) ) );
$GLOBALS['posts'] = array( 6 => $page( 'page', 'publish' ), 7 => $page( 'page', 'private' ), 8 => $page( 'page', 'publish' ), 9 => $page( 'page', 'publish' ), 10 => $page( 'page', 'trash' ) );
check( 'four valid pages, one private: nothing is missing', ! skyphusion_wc_store_pages_missing( array( 6, 7, 8, 9 ) ) );
check( 'shop set to none (-1): nothing is missing', ! skyphusion_wc_store_pages_missing( array( -1, 7, 8, 9 ) ) );
check( 'shop set to 0: nothing is missing', ! skyphusion_wc_store_pages_missing( array( 0, 7, 8, 9 ) ) );
check( 'an id whose post is gone is missing (#936)', skyphusion_wc_store_pages_missing( array( 6, 7, 8, 404 ) ) );
check( 'an id whose page is trashed is missing', skyphusion_wc_store_pages_missing( array( 6, 7, 8, 10 ) ) );
// #1006: the repair hands create_pages only the pages that are missing, so "none" and the refund page stay as set.
check( 'missing keys: only the dead cart', array( 'cart' ) === skyphusion_wc_store_pages_missing_keys( array( -1, 404, 8, 9 ) ) );
check( 'missing keys: none when shop is none and the rest valid', array() === skyphusion_wc_store_pages_missing_keys( array( 0, 7, 8, 9 ) ) );
$all = array( 'shop' => array( 'name' => 'shop' ), 'cart' => array( 'name' => 'cart' ), 'checkout' => array( 'name' => 'checkout' ), 'myaccount' => array( 'name' => 'my-account' ), 'refund_returns' => array( 'name' => 'refund_returns' ) );
check( 'create_pages list keeps only the missing cart (not shop=none, not refund_returns)', array( 'cart' ) === array_keys( skyphusion_wc_pages_keep_only( $all, array( 'cart' ) ) ) );
check( 'create_pages list is empty when nothing is missing', array() === skyphusion_wc_pages_keep_only( $all, array() ) );
check( 'a non-array list passes through', 'x' === skyphusion_wc_pages_keep_only( 'x', array( 'cart' ) ) );
check( 'stamp matches the same ids', skyphusion_wc_pages_stamp_matches( '6,7,8,9', array( 6, 7, 8, 9 ) ) );
check( 'stamp does not match a changed id', ! skyphusion_wc_pages_stamp_matches( '6,7,8,9', array( 6, 7, 8, 10 ) ) );
check( 'an empty stamp does not match', ! skyphusion_wc_pages_stamp_matches( '', array( 6, 7, 8, 9 ) ) );

echo $fail ? "$fail failing check(s)\n" : "all checks pass\n";
exit( $fail ? 1 : 0 );
