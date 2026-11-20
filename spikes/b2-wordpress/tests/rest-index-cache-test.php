<?php
/**
 * #1020: the pure parts of php/rest-index-cache.php. The live proof is tests/rest-index-cache-e2e.sh.
 * Run: php spikes/b2-wordpress/tests/rest-index-cache-test.php
 */
define( 'ABSPATH', '/tmp/' );
function add_filter() { return true; }
$fails = 0;
function ok( $label, $cond ) {
	global $fails;
	echo ( $cond ? 'PASS ' : 'FAIL ' ) . $label . "\n";
	if ( ! $cond ) {
		$fails++;
	}
}
require dirname( __DIR__ ) . '/php/rest-index-cache.php';
$C = 'Skyphusion_Rest_Index_Cache';

ok( 'build.sh copies the mu-plugin', false !== strpos( file_get_contents( dirname( __DIR__ ) . '/build.sh' ), 'php/rest-index-cache.php' ) );
ok( 'index.js defines SKYPHUSION_BUILD_ID for PHP', false !== strpos( file_get_contents( dirname( __DIR__ ) . '/index.js' ), "define('SKYPHUSION_BUILD_ID'" ) );

foreach ( array( '/wp-json/', '/wp-json', '/index.php?rest_route=/', '/?rest_route=/', '/?rest_route=' ) as $u ) {
	ok( "bare index: GET $u", $C::bare_index( 'GET', $u ) );
}
foreach ( array(
	array( 'HEAD', '/wp-json/' ),
	array( 'POST', '/wp-json/' ),
	array( 'GET', '/wp-json/?_fields=name' ),
	array( 'GET', '/wp-json/?_embed=1' ),
	array( 'GET', '/wp-json/?context=help' ),
	array( 'GET', '/wp-json/?_envelope' ),
	array( 'GET', '/wp-json/?_jsonp=f' ),
	array( 'GET', '/wp-json/?_pretty=1' ),
	array( 'GET', '/wp-json/wp/v2/posts' ),
	array( 'GET', '/?rest_route=/wp/v2' ),
	array( 'GET', '/?rest_route=/&_fields=name' ),
	array( 'GET', '/wp-json/?nocache=1' ),
	array( 'GET', '/' ),
) as $c ) {
	ok( "not the bare index: {$c[0]} {$c[1]}", ! $C::bare_index( $c[0], $c[1] ) );
}

$base = array( 'build' => 'b1', 'user' => 0, 'o:active_plugins' => array( 'woocommerce/woocommerce.php' ), 'o:blogname' => 'Site' );
$k    = $C::key_of( $base );
ok( 'the key is stable and independent of part order', $k === $C::key_of( array_reverse( $base, true ) ) );
foreach ( array( 'build' => 'b2', 'user' => 1, 'o:active_plugins' => array( 'woocommerce/woocommerce.php', 'hello.php' ), 'o:blogname' => 'Other' ) as $part => $v ) {
	$changed          = $base;
	$changed[ $part ] = $v;
	ok( "a changed $part is a different key", $k !== $C::key_of( $changed ) );
}

ok( 'no credentials: a plain guest', ! $C::has_credentials( array( 'HTTP_ACCEPT' => '*/*' ), array( 'woocommerce_cart_hash' => 'x' ) ) );
foreach ( array( 'HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION', 'PHP_AUTH_USER', 'PHP_AUTH_PW' ) as $h ) {
	ok( "credentials: $h", $C::has_credentials( array( $h => 'Basic eA==' ), array() ) );
}
foreach ( array( 'wordpress_logged_in_abc', 'wordpress_sec_abc', 'wordpress_test_cookie', 'wp-settings-1' ) as $c ) {
	ok( "credentials: cookie $c", $C::has_credentials( array(), array( $c => '1' ) ) );
}

echo $fails . " failing\n";
exit( $fails ? 1 : 0 );
