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
echo $fail ? "$fail failing check(s)\n" : "all checks pass\n";
exit( $fail ? 1 : 0 );
