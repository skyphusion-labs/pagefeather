<?php
// php spikes/b2-wordpress/tests/wc-route-defer-rest-test.php (issue #987)
// A non-wc REST path defers WooCommerce routes. /wc, /jetpack, and the index stay eager.
// The plugin deactivate PUT is the path that lost one statement on the hot runtime.
$fail = 0;
function check( $label, $got, $want ) {
	global $fail;
	if ( $got === $want ) { echo "ok   $label\n"; return; }
	$fail++;
	echo "FAIL $label\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
}
if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ );
}
function add_action( ...$a ) {}
function add_filter( ...$a ) {}
require __DIR__ . '/../php/wc-route-defer.php';

$fn = array( 'Skyphusion_WC_Route_Defer', 'rest_defers_uri' );
$defer = array(
	'plugin deactivate, plain permalink' => '/index.php/wp-json/wp/v2/plugins/gutenberg-test-plugins/default-post-content',
	'plugin deactivate, pretty permalink' => '/wp-json/wp/v2/plugins/gutenberg-test-plugins/default-post-content',
	'core types' => '/wp-json/wp/v2/types',
	'rest_route query' => '/index.php?rest_route=/wp/v2/plugins',
	'rest_route query, encoded' => '/index.php?rest_route=%2Fwp%2Fv2%2Fplugins',
);
$eager = array(
	'wc products' => '/wp-json/wc/v3/products',
	'wc products, plain permalink' => '/index.php/wp-json/wc/v3/products',
	'wc store' => '/index.php/wp-json/wc/store/v1/cart',
	'wc-admin' => '/wp-json/wc-admin/options',
	'jetpack' => '/wp-json/jetpack/v4/connection',
	'index' => '/wp-json/',
	'index, no slash' => '/wp-json',
	'index, plain permalink' => '/index.php/wp-json/',
	'index fields' => '/wp-json/?_fields=description',
	'rest_route index' => '/index.php?rest_route=/',
	'rest_route wc' => '/index.php?rest_route=/wc/v3/products',
	'front page' => '/',
	'empty' => '',
);
foreach ( $defer as $label => $uri ) {
	check( $label . ' defers', $fn( $uri ), true );
}
foreach ( $eager as $label => $uri ) {
	check( $label . ' stays eager', $fn( $uri ), false );
}

define( 'REST_REQUEST', true );
$_SERVER['REQUEST_URI'] = '/index.php/wp-json/wp/v2/plugins/gutenberg-test-plugins/default-post-content';
check( 'in_scope defers the plugin PUT', Skyphusion_WC_Route_Defer::in_scope(), true );
$_SERVER['REQUEST_URI'] = '/wp-json/wc/v3/products';
check( 'in_scope leaves /wc eager', Skyphusion_WC_Route_Defer::in_scope(), false );
$_SERVER['HTTP_X_PF_WC_DEFER'] = 'force';
check( 'force still defers /wc', Skyphusion_WC_Route_Defer::in_scope(), true );

echo ( $fail ? $fail . " failing\n" : "ok\n" );
exit( $fail ? 1 : 0 );
