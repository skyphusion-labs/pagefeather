<?php
// php spikes/b2-wordpress/tests/wc-route-defer-rest-test.php (issue #987)
// A REST path defers WooCommerce routes, except the index (#987, #994).
// /wc and /jetpack defer too. on_demand registers only the namespace the call needs.
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
$defer += array(
	'wc products' => '/wp-json/wc/v3/products',
	'wc products, plain permalink' => '/index.php/wp-json/wc/v3/products',
	'wc store' => '/index.php/wp-json/wc/store/v1/cart',
	'wc-admin' => '/wp-json/wc-admin/options',
	'jetpack' => '/wp-json/jetpack/v4/connection',
);
$eager = array(
	'index' => '/wp-json/',
	'index, no slash' => '/wp-json',
	'index, plain permalink' => '/index.php/wp-json/',
	'index fields' => '/wp-json/?_fields=description',
	'rest_route index' => '/index.php?rest_route=/',
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
check( 'in_scope defers /wc', Skyphusion_WC_Route_Defer::in_scope(), true );
$_SERVER['REQUEST_URI'] = '/wp-json/wc-admin/plugins/active';
check( 'in_scope defers /wc-admin', Skyphusion_WC_Route_Defer::in_scope(), true );
$_SERVER['REQUEST_URI'] = '/wp-json/';
check( 'in_scope leaves the index eager', Skyphusion_WC_Route_Defer::in_scope(), false );
$_SERVER['HTTP_X_PF_WC_DEFER'] = 'force';
check( 'force still defers /wc', Skyphusion_WC_Route_Defer::in_scope(), true );

$own = array( 'Skyphusion_WC_Route_Defer', 'owners_for_route' );
$admin = $own( '/wc-admin/plugins/active' );
check( 'wc-admin asks for Admin API Init only', $admin, array( 'Automattic\\WooCommerce\\Admin\\API\\Init::rest_api_init' ) );
check( 'wc-analytics shares that callback', $own( '/wc-analytics/admin/notes' ), $admin );
$wc = $own( '/wc/v3/products' );
check( 'wc/v3 asks for the REST server only', $wc, array( 'Automattic\\WooCommerce\\RestApi\\Server::register_rest_routes' ) );
$jp = $own( '/jetpack/v4/connection' );
check( 'jetpack asks for three callbacks', is_array( $jp ) && count( $jp ) === 3, true );
check( 'an unknown wc- namespace uses the whole map', $own( '/wc-telemetry/ping' ), null );
check( 'the index uses the whole map', $own( '/' ), null );
echo ( $fail ? $fail . " failing\n" : "ok\n" );
exit( $fail ? 1 : 0 );

