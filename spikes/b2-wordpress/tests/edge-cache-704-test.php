<?php
// #704: deleting a WooCommerce order must ask no page-cache purge, and nothing else may change.
// The call path, read in WooCommerce 11.2.1 (OrdersTableDataStore::delete -> handle_order_deletion_with_sync_disabled)
// and WordPress 7.1.4: each order comment goes through wp_delete_comment(), which fires delete_comment($id, $comment)
// BEFORE the row is deleted and clean_comment_cache($id) AFTER, when get_comment() finds nothing. Then the
// shop_order_placehold row is DELETEd and clean_post_cache($order_id) runs: core's get_post() still finds the post
// in the object cache and fires do_action('clean_post_cache', $id, $post), when get_post_type($id) is false.
// Measured on pf704 (2026-11-16): 119 of each, from load.py's CLEANUP deleting the 119 orders it made.
// The tests use core's REAL call shapes: clean_post_cache is ($id, $post); a deleted row reads no type by id.
// Run: php spikes/b2-wordpress/tests/edge-cache-704-test.php
$GLOBALS['actions'] = array();
$GLOBALS['sent'] = array();
$GLOBALS['filter'] = '';
$GLOBALS['rows_gone'] = array(); // post ids whose wp_posts row is deleted: get_post_type($id) is false
$GLOBALS['comments_gone'] = array(); // comment ids whose row is deleted: get_comment($id) is null
function add_action( $hook, $fn, $prio = 10, $n = 1 ) { $GLOBALS['actions'][ $hook ][] = array( $fn, $n ); }
function do_action() {}
function current_filter() { return $GLOBALS['filter']; }
function post_message_to_js( $m ) { $GLOBALS['sent'][] = json_decode( $m, true ); return '{}'; }
function get_post_type( $p ) {
	if ( is_object( $p ) ) { return $p->post_type; }
	if ( in_array( $p, $GLOBALS['rows_gone'], true ) ) { return false; }
	return array( 7 => 'product', 8 => 'page', 12 => 'wp_template', 15 => 'post', 101 => 'shop_order_placehold' )[ $p ] ?? false;
}
function get_post_status( $p ) { return 'publish'; }
function comment_obj( $id ) {
	$c = array( 202 => array( 'order_note', 101 ), 203 => array( 'comment', 15 ), 204 => array( 'review', 7 ) );
	return isset( $c[ $id ] ) ? (object) array( 'comment_ID' => $id, 'comment_type' => $c[ $id ][0], 'comment_post_ID' => $c[ $id ][1] ) : null;
}
function get_comment( $id ) { return in_array( $id, $GLOBALS['comments_gone'], true ) ? null : comment_obj( $id ); }
$bad = 0;
$GLOBALS['php_warnings'] = 0;
set_error_handler( function ( $no, $msg, $file ) { if ( false !== strpos( $file, 'edge-cache.php' ) ) { $GLOBALS['php_warnings']++; } return true; } );
function check( $name, $ok ) { global $bad; echo ( $ok ? 'PASS ' : 'FAIL ' ) . $name . "\n"; if ( ! $ok ) { $bad++; } }
// fire(): calls each callback with only as many arguments as it was registered to accept, as WordPress does.
function fire( $hook, ...$args ) {
	$GLOBALS['filter'] = $hook;
	foreach ( $GLOBALS['actions'][ $hook ] ?? array() as $reg ) { list( $fn, $n ) = $reg; $fn( ...array_slice( $args, 0, $n ) ); }
}
function sent_why() { return array_values( array_filter( array_map( function ( $m ) { return $m['why'] ?? null; }, $GLOBALS['sent'] ) ) ); }

require __DIR__ . '/../php/edge-cache.php';

// Each block is its own request: edge-cache.php keeps its reasons per request (a static), so blocks 2 and 3
// run in a fresh PHP process.
$block = $argv[1] ?? 'main';
function sub( $name ) {
	$out = shell_exec( escapeshellarg( PHP_BINARY ) . ' ' . escapeshellarg( __FILE__ ) . ' ' . $name );
	echo $out;
	return false !== strpos( (string) $out, "$name: done" ) && false === strpos( (string) $out, 'FAIL ' );
}

if ( 'main' === $block ) {
	// 1. Deleting an HPOS order, in core's order: its note is deleted (delete_comment, the row, then
	//    clean_comment_cache), then the placeholder row is deleted and clean_post_cache($id, $post) fires.
	$GLOBALS['sent'] = array();
	$note = comment_obj( 202 );
	fire( 'delete_comment', 202, $note );
	$GLOBALS['comments_gone'][] = 202;
	fire( 'clean_comment_cache', 202 );
	$placeholder = (object) array( 'ID' => 101, 'post_type' => 'shop_order_placehold' );
	$GLOBALS['rows_gone'][] = 101;
	fire( 'clean_post_cache', 101, $placeholder );
	check( 'deleting an order asks no purge (its note, then its placeholder row)', array() === $GLOBALS['sent'] );
	check( 'deleting an order raises no PHP warning in edge-cache.php', 0 === $GLOBALS['php_warnings'] );
	if ( ! sub( 'block2' ) ) { $bad++; }
	if ( ! sub( 'block3' ) ) { $bad++; }
	if ( $bad ) { echo "$bad FAILED\n"; exit( 1 ); }
	echo "edge-cache-704-test: all pass\n";
	exit( 0 );
}

if ( 'block2' === $block ) {
	// 2. A force-deleted published page, in core's shape: the row and its cache are gone, so get_post_type($id)
	//    is false, and the post object is the SECOND argument. It must purge (the review on #727).
	$GLOBALS['rows_gone'][] = 8;
	fire( 'clean_post_cache', 8, (object) array( 'ID' => 8, 'post_type' => 'page' ) );
	check( 'a force-deleted published page still purges (core shape: id, then object)', in_array( 'clean_post_cache:page', sent_why(), true ) );
	// A deleted public comment (not an order note) still purges, as before.
	fire( 'delete_comment', 203, comment_obj( 203 ) );
	$GLOBALS['comments_gone'][] = 203;
	fire( 'clean_comment_cache', 203 );
	check( 'a deleted public comment still purges', in_array( 'clean_comment_cache', sent_why(), true ) || in_array( 'clean_comment_cache:comment', sent_why(), true ) );
	echo "block2: done\n";
	exit( $bad ? 1 : 0 );
}

if ( 'block3' === $block ) {
	// 3. Ordinary changes still purge, each with core's call shape.
	fire( 'clean_post_cache', 15, (object) array( 'ID' => 15, 'post_type' => 'post' ) );
	check( 'a content edit still purges', in_array( 'clean_post_cache:post', sent_why(), true ) );
	fire( 'clean_post_cache', 12, (object) array( 'ID' => 12, 'post_type' => 'wp_template' ) );
	check( 'a block-theme template edit still purges', in_array( 'clean_post_cache:wp_template', sent_why(), true ) );
	fire( 'clean_comment_cache', 204 );
	check( 'a product review still purges', in_array( 'clean_comment_cache:review', sent_why(), true ) );
	fire( 'woocommerce_product_set_stock_status', 7, 'outofstock', null );
	check( 'a stock-status change still purges', in_array( 'woocommerce_product_set_stock_status:outofstock', sent_why(), true ) );
	// An order note added in a checkout (the comment exists, type order_note) asks nothing, as before.
	$GLOBALS['sent'] = array();
	fire( 'clean_comment_cache', 202 );
	check( 'adding an order note asks no purge', array() === $GLOBALS['sent'] );
	echo "block3: done\n";
	exit( $bad ? 1 : 0 );
}
