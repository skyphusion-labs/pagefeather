<?php
// php spikes/b2-wordpress/tests/object-cache-shadow-test.php   (#1210 lever 2)
// WooCommerce's order-item data store drops an item's meta cache on EVERY item save (clear_cache(),
// abstract-wc-order-item-type-data-store.php:222), changed or not, so core reloads the item's meta from the database
// again. A local guest order: 25 loads for 9 writes, the last 16 with no write between; live (cf759hl) 44 loads, 605 ms.
// The drop-in keeps the request's last loaded order_item_meta as a SHADOW and serves it on a later miss, while NO write
// statement has touched woocommerce_order_itemmeta. Any statement naming that table (any prefix) that is not plainly a
// read clears every shadow: INSERT, UPDATE, DELETE, REPLACE, a multi-table DELETE, or one that cannot be parsed. WooCommerce
// writes the table directly with $wpdb on item and order deletes, so the guard is on statements, not on meta actions.
// Request-local only. WordPress stubbed; the real drop-in is loaded and its query filter driven.
$GLOBALS['filters'] = array();
function add_filter( $h, $cb, $p = 10, $n = 1 ) { $GLOBALS['filters'][ $h ][] = $cb; }
function add_action( $h, $cb, $p = 10, $n = 1 ) {}
function post_message_to_js( $json ) { return json_encode( array( 'ok' => true, 'v' => array() ) ); }
function is_multisite() { return false; }
function get_current_blog_id() { return 1; }
function wp_suspend_cache_addition() { return false; }
function wp_installing() { return false; }
function get_option( $n, $d = false ) { return $d; }
define( 'JS_OBJECT_CACHE_PERSIST_GROUPS', 'theme_json' );
require isset( $argv[1] ) ? $argv[1] : __DIR__ . '/../php/object-cache-js.php';
$fail = 0;
function check( $label, $cond ) { global $fail; echo ( $cond ? 'ok   ' : 'FAIL ' ) . $label . "\n"; $fail += $cond ? 0 : 1; }
function stmt( $q ) { foreach ( $GLOBALS['filters']['query'] ?? array() as $cb ) { $q = call_user_func( $cb, $q ); } return $q; }
$G = 'order_item_meta';
$meta = array( '_qty' => array( '1' ), '_product_id' => array( '10' ) );
// load (core's update_meta_cache: wp_cache_add_multiple), then WooCommerce's clear_cache (a delete), then a read
$fresh = function () use ( $G, $meta ) { $c = new JS_Object_Cache(); $c->add_multiple( array( 5 => $meta ), $G ); $c->delete( 5, $G ); return $c; };

$c = $fresh();
check( 'the drop-in hooks the query filter (when the cache starts)', ! empty( $GLOBALS['filters']['query'] ) ); $f = null; $v = $c->get( 5, $G, false, $f );
check( 'no write since the load: the read after clear_cache is served from the shadow', true === $f && $meta === $v );
$r = $c->get_multiple( array( 5 ), $G );
check( '  get_multiple too (update_meta_cache asks with it)', $meta === $r[5] );
check( 'the statement itself is passed through untouched', 'SELECT 1' === stmt( 'SELECT 1' ) );

foreach ( array(
	'a meta-API write (INSERT)'          => "INSERT INTO `wp_woocommerce_order_itemmeta` (`order_item_id`, `meta_key`, `meta_value`) VALUES (5, '_qty', '2')",
	'an UPDATE'                          => "UPDATE `wp_woocommerce_order_itemmeta` SET `meta_value` = '3' WHERE `meta_id` = 9",
	'a direct $wpdb DELETE (item delete)'=> "DELETE FROM `wp_woocommerce_order_itemmeta` WHERE `order_item_id` = 5",
	'the multi-table DELETE (class-wc-post-data.php:613)' => "DELETE wp_woocommerce_order_items, wp_woocommerce_order_itemmeta FROM wp_woocommerce_order_items JOIN wp_woocommerce_order_itemmeta ON wp_woocommerce_order_items.order_item_id = wp_woocommerce_order_itemmeta.order_item_id WHERE wp_woocommerce_order_items.order_id = 12",
	'a REPLACE'                          => "REPLACE INTO wp_woocommerce_order_itemmeta (meta_id, order_item_id, meta_key, meta_value) VALUES (9, 5, '_qty', '4')",
	'a prefix variant (custom prefix, no backticks)' => "delete from shop7_woocommerce_order_itemmeta where order_item_id = 5",
	'an unparseable statement naming the table' => "/* c */ (DELETE FROM wp_woocommerce_order_itemmeta WHERE order_item_id = 5)",
	'a WITH statement that writes'       => "WITH t AS (SELECT 1) DELETE FROM wp_woocommerce_order_itemmeta WHERE order_item_id = 5",
) as $why => $q ) {
	$c = $fresh(); stmt( $q ); $f = null; $c->get( 5, $G, false, $f );
	check( "after $why: a real reload (the shadow is cleared)", false === $f );
}
$c = $fresh(); stmt( "SELECT order_item_id, meta_key, meta_value FROM wp_woocommerce_order_itemmeta WHERE order_item_id IN (5) ORDER BY meta_id ASC" ); $f = null; $c->get( 5, $G, false, $f );
check( 'a SELECT of the table keeps the shadow (a read changes nothing)', true === $f );
$c = $fresh(); stmt( "INSERT INTO `wp_options` (`option_name`) VALUES ('x')" ); $f = null; $c->get( 5, $G, false, $f );
check( 'a write to another table keeps the shadow', true === $f );
$c = $fresh(); $f = null; $c->get( 5, $G, true, $f );
check( 'a forced read never uses the shadow', false === $f );
$c = new JS_Object_Cache(); $f = null; $c->get( 5, $G, false, $f );
check( 'a new request (a fresh runtime) has no shadow', false === $f );
$c = new JS_Object_Cache(); $c->add_multiple( array( 7 => $meta ), 'post_meta' ); $c->delete( 7, 'post_meta' ); $f = null; $c->get( 7, 'post_meta', false, $f );
check( 'only order_item_meta is shadowed (post_meta reloads)', false === $f );
$c = $fresh(); $c->flush_runtime(); $f = null; $c->get( 5, $G, false, $f );
check( 'a runtime flush clears the shadow', false === $f );
$c = $fresh(); $c->set( 5, array( '_qty' => array( '9' ) ), $G ); $c->delete( 5, $G ); $f = null; $v = $c->get( 5, $G, false, $f );
check( 'the shadow is the LAST value the request set', true === $f && array( '_qty' => array( '9' ) ) === $v );
echo $fail ? "$fail FAILED\n" : "ALL PASS\n";
exit( $fail ? 1 : 0 );
