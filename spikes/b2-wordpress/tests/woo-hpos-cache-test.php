<?php
// php spikes/b2-wordpress/tests/woo-hpos-cache-test.php [path/to/woo-hpos-cache.php]   (#697)
//
// The must-use plugin: with SKYPHUSION_WOO_HPOS_CACHE = 'on', the HPOS Data Caching option reads "yes" through a
// pre_option filter (nothing is written), late enough that another pre_option callback cannot put "no" back. Without
// the constant it adds nothing, so WooCommerce's own setting stays. No other option is touched.
$GLOBALS['filters'] = array();
function add_filter( $tag, $cb, $prio = 10, $args = 1 ) {
	$GLOBALS['filters'][] = array( $tag, $cb, $prio );
	return true;
}
$plugin = isset( $argv[1] ) ? $argv[1] : __DIR__ . '/../php/woo-hpos-cache.php';
$fail = 0;
function check( $label, $cond ) {
	global $fail;
	echo ( $cond ? 'ok   ' : 'FAIL ' ) . $label . "\n";
	$fail += $cond ? 0 : 1;
}
$OPT = 'woocommerce_hpos_datastore_caching_enabled';

// Without the constant (included in a closure scope, as WordPress does with mu-plugins).
( function () use ( $plugin ) { include $plugin; } )();
check( 'no constant: no filter at all (WooCommerce keeps its own setting)', 0 === count( $GLOBALS['filters'] ) );

define( 'SKYPHUSION_WOO_HPOS_CACHE', 'on' );
( function () use ( $plugin ) { include $plugin; } )();
$mine = array_values( array_filter( $GLOBALS['filters'], function ( $f ) use ( $OPT ) { return 'pre_option_' . $OPT === $f[0]; } ) );
check( 'constant on: one pre_option filter on the HPOS Data Caching option', 1 === count( $mine ) );
check( 'it returns "yes"', isset( $mine[0] ) && 'yes' === call_user_func( $mine[0][1], false, $OPT, false ) );
check( 'it runs late (priority 9999), as woo-extras.php does', isset( $mine[0] ) && 9999 === $mine[0][2] );
check( 'no other option is filtered', count( $GLOBALS['filters'] ) === count( $mine ) );

echo $fail ? "$fail failing check(s)\n" : "all checks pass\n";
exit( $fail ? 1 : 0 );
