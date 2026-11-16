<?php
// edge-cache.php names WHY it asks a page-cache purge (#704): an ordinary checkout asks about one purge
// per order (pf628, 2026-11-15: 150 asks for 145 checkouts), and every sent purge empties every cached
// page of the site. Each distinct reason in a request goes to the Worker as {cache: purge, why: ...},
// which logs it as m: purge-why. The reason is a hook and a NAME only (an option name, a post type, a
// taxonomy, a comment type, a stock status), never a value. A transient or a lock still asks nothing.
// Run: php spikes/b2-wordpress/tests/edge-cache-why-test.php
$GLOBALS['actions'] = array();
$GLOBALS['sent'] = array();
$GLOBALS['filter'] = '';
function add_action( $hook, $fn, $prio = 10, $n = 1 ) { $GLOBALS['actions'][ $hook ][] = $fn; $GLOBALS['nargs'][ $hook ] = $n; }
function do_action() {}
function current_filter() { return $GLOBALS['filter']; }
function post_message_to_js( $m ) { $GLOBALS['sent'][] = json_decode( $m, true ); return '{}'; }
function get_post_type( $id ) { return array( 7 => 'product', 8 => 'page', 9 => 'shop_order', 10 => 'customize_changeset' )[ $id ] ?? false; }
function get_post_status( $id ) { return 'publish'; }
function get_comment( $id ) { return (object) array( 'comment_type' => $id === 3 ? 'order_note' : 'review' ); }
$bad = 0;
function check( $name, $ok ) { global $bad; echo ( $ok ? 'PASS ' : 'FAIL ' ) . $name . "\n"; if ( ! $ok ) { $bad++; } }
function fire( $hook, ...$args ) { $GLOBALS['filter'] = $hook; foreach ( $GLOBALS['actions'][ $hook ] ?? array() as $fn ) { $fn( ...$args ); } }
function whys() { return array_values( array_filter( array_map( function ( $m ) { return $m['why'] ?? null; }, $GLOBALS['sent'] ) ) ); }

require __DIR__ . '/../php/edge-cache.php';

check( 'the reason function exists', function_exists( 'skyphusion_edge_cache_reason' ) );
if ( function_exists( 'skyphusion_edge_cache_reason' ) ) {
	check( 'updated_option names the option', 'updated_option:blogname' === skyphusion_edge_cache_reason( 'updated_option', array( 'blogname', 'old', 'new' ) ) );
	check( 'clean_post_cache names the post type', 'clean_post_cache:product' === skyphusion_edge_cache_reason( 'clean_post_cache', array( 7 ) ) );
	check( 'clean_term_cache names the taxonomy', 'clean_term_cache:product_cat' === skyphusion_edge_cache_reason( 'clean_term_cache', array( array( 4 ), 'product_cat', true ) ) );
	check( 'clean_comment_cache names the comment type', 'clean_comment_cache:review' === skyphusion_edge_cache_reason( 'clean_comment_cache', array( 5 ) ) );
	check( 'the stock status hook names the status', 'woocommerce_product_set_stock_status:outofstock' === skyphusion_edge_cache_reason( 'woocommerce_product_set_stock_status', array( 7, 'outofstock', null ) ) );
	check( 'another hook is its name', 'switch_theme' === skyphusion_edge_cache_reason( 'switch_theme', array( 'Twenty', null ) ) );
	check( 'never a value: an option value is not in the reason', false === strpos( skyphusion_edge_cache_reason( 'updated_option', array( 'my_opt', 'secret-old', 'secret-new' ) ), 'secret' ) );
	check( 'a long name is cut to 120 characters', 120 >= strlen( skyphusion_edge_cache_reason( 'updated_option', array( str_repeat( 'x', 500 ) ) ) ) );
}

// WordPress passes only accepted_args arguments: the taxonomy and the status need 3.
foreach ( array( 'clean_term_cache', 'woocommerce_product_set_stock_status', 'woocommerce_variation_set_stock_status' ) as $h ) {
	check( "$h is registered with 3 accepted arguments", 3 === ( $GLOBALS['nargs'][ $h ] ?? 0 ) );
}

// One request: the first reason asks the purge; a repeat sends nothing more; a NEW reason is sent too.
$GLOBALS['sent'] = array();
fire( 'updated_option', 'blogname', 'a', 'b' );
fire( 'updated_option', 'blogname', 'b', 'c' );
fire( 'clean_post_cache', 8, null );
check( 'every message still asks the purge', count( $GLOBALS['sent'] ) > 0 && ! array_filter( $GLOBALS['sent'], function ( $m ) { return ( $m['cache'] ?? '' ) !== 'purge'; } ) );
check( 'each distinct reason is sent once', whys() === array( 'updated_option:blogname', 'clean_post_cache:page' ) );
// The exclusions still ask nothing: a transient, a lock, an order, an order note.
$GLOBALS['sent'] = array();
fire( 'updated_option', '_transient_wc_x', 'a', 'b' );
fire( 'updated_option', 'wc_batch_lock', 'a', 'b' );
fire( 'clean_post_cache', 9, null );
fire( 'clean_comment_cache', 3 );
check( 'the exclusions send nothing', array() === $GLOBALS['sent'] );

if ( $bad ) { echo "$bad FAILED\n"; exit( 1 ); }
echo "edge-cache-why-test: all pass\n";
