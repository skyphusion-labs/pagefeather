<?php
// #704: an ordinary checkout must ask NO page-cache purge. Measured on pf704 (2026-11-16): 124 asks for
// 119 ok checkouts, as clean_post_cache with NO type (119) and clean_comment_cache with NO type (119). An
// HPOS order id is not a row in wp_posts, so get_post_type() is false, and false matched no exclusion; a
// comment that WordPress cannot find purged on "! $c". Neither is on a page a guest sees. Real changes must
// still purge: a content edit, a deleted page, a block-theme template (not publicly viewable, yet on every
// page), a public comment, a product review, a stock-status change.
// Run: php spikes/b2-wordpress/tests/edge-cache-704-test.php
$GLOBALS['actions'] = array();
$GLOBALS['sent'] = array();
$GLOBALS['filter'] = '';
function add_action( $hook, $fn, $prio = 10, $n = 1 ) { $GLOBALS['actions'][ $hook ][] = $fn; }
function do_action() {}
function current_filter() { return $GLOBALS['filter']; }
function post_message_to_js( $m ) { $GLOBALS['sent'][] = json_decode( $m, true ); return '{}'; }
// 101 is an HPOS order id: no row in wp_posts. 12 is a wp_template. A WP_Post object carries its own type.
function get_post_type( $p ) {
	if ( is_object( $p ) ) { return $p->post_type; }
	return array( 7 => 'product', 8 => 'page', 12 => 'wp_template', 15 => 'post' )[ $p ] ?? false;
}
function get_post_status( $p ) { return 'publish'; }
function is_post_type_viewable( $t ) { return in_array( $t, array( 'post', 'page', 'product' ), true ); }
// 201 is not found. 202 is an order note on the order. 203 is a public comment on a post. 204 is a review
// on a product. 205 is a plain comment on the order id (no post row).
function get_comment( $id ) {
	$c = array( 202 => array( 'order_note', 101 ), 203 => array( 'comment', 15 ), 204 => array( 'review', 7 ), 205 => array( 'comment', 101 ) );
	return isset( $c[ $id ] ) ? (object) array( 'comment_type' => $c[ $id ][0], 'comment_post_ID' => $c[ $id ][1] ) : null;
}
$bad = 0;
// A warning or notice from edge-cache.php is a failure too: it would be logged on every checkout.
$GLOBALS['php_warnings'] = 0;
set_error_handler( function ( $no, $msg, $file ) { if ( false !== strpos( $file, 'edge-cache.php' ) ) { $GLOBALS['php_warnings']++; } return true; } );
function check( $name, $ok ) { global $bad; echo ( $ok ? 'PASS ' : 'FAIL ' ) . $name . "\n"; if ( ! $ok ) { $bad++; } }
function fire( $hook, ...$args ) { $GLOBALS['filter'] = $hook; foreach ( $GLOBALS['actions'][ $hook ] ?? array() as $fn ) { $fn( ...$args ); } }
function sent_why() { return array_values( array_filter( array_map( function ( $m ) { return $m['why'] ?? null; }, $GLOBALS['sent'] ) ) ); }

require __DIR__ . '/../php/edge-cache.php';

// Each block is its own request: edge-cache.php keeps a per-request set of reasons (a static), so block 2
// runs in a fresh PHP process. In one process, a reason seen in block 1 would hide the same reason in block 2.
$block = $argv[1] ?? 'main';

// 1. An ordinary checkout: the order's post cache (an HPOS id), its order note, a comment not found, and a
//    comment on the order. None is on a page: NO purge at all.
if ( 'main' === $block ) {
$GLOBALS['sent'] = array();
fire( 'clean_post_cache', 101, null );
fire( 'clean_comment_cache', 202 );
fire( 'clean_comment_cache', 201 );
fire( 'clean_comment_cache', 205 );
check( 'a checkout asks no purge (order id with no post row, its note, a missing comment, a comment on the order)', array() === $GLOBALS['sent'] );
check( 'a checkout raises no PHP warning in edge-cache.php', 0 === $GLOBALS['php_warnings'] );

$out = shell_exec( escapeshellarg( PHP_BINARY ) . ' ' . escapeshellarg( __FILE__ ) . ' block2' );
echo $out;
if ( false === strpos( (string) $out, 'block2: done' ) || false !== strpos( (string) $out, 'FAIL ' ) ) { $bad++; }
}

// 2. Real changes still purge, each with its own reason (a fresh request).
if ( 'block2' === $block ) {
$GLOBALS['sent'] = array();
fire( 'clean_post_cache', 15, null );
check( 'a content edit still purges', in_array( 'clean_post_cache:post', sent_why(), true ) );
fire( 'clean_post_cache', (object) array( 'post_type' => 'page', 'ID' => 99 ), null );
check( 'a deleted page (passed as its object) still purges', in_array( 'clean_post_cache:page', sent_why(), true ) );
fire( 'clean_post_cache', 12, null );
check( 'a block-theme template edit (not publicly viewable) still purges', in_array( 'clean_post_cache:wp_template', sent_why(), true ) );
fire( 'clean_comment_cache', 203 );
check( 'a public comment on a post still purges', in_array( 'clean_comment_cache:comment', sent_why(), true ) );
fire( 'clean_comment_cache', 204 );
check( 'a product review still purges', in_array( 'clean_comment_cache:review', sent_why(), true ) );
fire( 'woocommerce_product_set_stock_status', 7, 'outofstock', null );
check( 'a stock-status change still purges', in_array( 'woocommerce_product_set_stock_status:outofstock', sent_why(), true ) );

echo "block2: done\n";
exit( $bad ? 1 : 0 );
}

if ( $bad ) { echo "$bad FAILED\n"; exit( 1 ); }
echo "edge-cache-704-test: all pass\n";
