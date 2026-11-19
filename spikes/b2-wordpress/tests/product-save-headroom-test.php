<?php
/**
 * Product admin writes free allocator caches and cap the object cache (#963).
 *
 * A suite-hot post.php or admin-ajax.php write resets the isolate.
 * The mu-plugin does not unload WooCommerce. REST product routes do not match.
 *
 * Run: php spikes/b2-wordpress/tests/product-save-headroom-test.php
 */

$fails = 0;
function ok( $label, $cond ) {
	global $fails;
	echo ( $cond ? 'PASS ' : 'FAIL ' ) . $label . "\n";
	if ( ! $cond ) {
		$fails++;
	}
}

$root = dirname( __DIR__ );
$php  = file_get_contents( $root . '/php/product-save-headroom.php' );
$idx  = file_get_contents( $root . '/index.js' );
$bld  = file_get_contents( $root . '/build.sh' );
ok( 'the gate returns when the constant is off', false !== strpos( $php, "if ( ! defined( 'SKYPHUSION_PRODUCT_HEADROOM' ) || ! SKYPHUSION_PRODUCT_HEADROOM ) {\n\treturn;\n}" ) );
ok( 'index.js defines the gate on b-dosql', false !== strpos( $idx, "define('SKYPHUSION_PRODUCT_HEADROOM', true)" ) );
ok( 'index.js honors PRODUCT_HEADROOM=off', false !== strpos( $idx, "ENV.PRODUCT_HEADROOM !== 'off'" ) );
ok( 'build.sh copies the mu-plugin', false !== strpos( $bld, 'php/product-save-headroom.php' ) );
ok( 'a non-matching request returns before the hooks', false !== strpos( $php, "if ( '' === skyphusion_product_headroom_script() ) {\n\treturn;\n}" ) );
ok( 'WooCommerce stays loaded', false === strpos( $php, 'option_active_plugins' ) );
ok( 'the cap is 1 MiB', false !== strpos( $php, "'n' => 1048576" ) );

$GLOBALS['actions'] = array();
$GLOBALS['msgs']    = array();
$GLOBALS['flushed'] = 0;
function add_action( $h, $cb, $prio = 10 ) {
	$GLOBALS['actions'][ $h ][] = array( $cb, $prio );
	return true;
}
function post_message_to_js( $s ) {
	$GLOBALS['msgs'][] = $s;
	return '{}';
}
function wp_json_encode( $v ) {
	return json_encode( $v );
}
function wp_cache_flush() {
	$GLOBALS['flushed']++;
	return true;
}

define( 'SKYPHUSION_PRODUCT_HEADROOM', true );
$_SERVER['REQUEST_URI'] = '/wp-admin/admin-ajax.php?action=woocommerce_save_variations';
$GLOBALS['wp_object_cache'] = new stdClass();
require $root . '/php/product-save-headroom.php';

ok( 'admin-ajax matches', 'admin-ajax.php' === skyphusion_product_headroom_script() );
ok( 'sent the 1 MiB cap', isset( $GLOBALS['msgs'][0] ) && false !== strpos( $GLOBALS['msgs'][0], '"n":1048576' ) && false !== strpos( $GLOBALS['msgs'][0], '"op":"cap"' ) );
ok( 'flushed the object cache', 1 === $GLOBALS['flushed'] );
ok( 'frees caches again at plugins_loaded', isset( $GLOBALS['actions']['plugins_loaded'] ) && 0 === $GLOBALS['actions']['plugins_loaded'][0][1] );

$_SERVER['REQUEST_URI'] = '/wp-admin/post.php?post=12&action=edit';
ok( 'post.php matches', 'post.php' === skyphusion_product_headroom_script() );
$_SERVER['REQUEST_URI'] = '/wp-admin/post-new.php?post_type=product';
ok( 'post-new.php matches', 'post-new.php' === skyphusion_product_headroom_script() );
$_SERVER['REQUEST_URI'] = '/wp-json/wc/v3/products';
ok( 'a WooCommerce REST create does not match', '' === skyphusion_product_headroom_script() );
$_SERVER['REQUEST_URI'] = '/wp-admin/profile.php';
ok( 'profile.php does not match', '' === skyphusion_product_headroom_script() );
$_SERVER['REQUEST_URI'] = '/wp-admin/edit.php?post_type=product';
ok( 'the product list does not match', '' === skyphusion_product_headroom_script() );
$_SERVER['REQUEST_URI'] = '/';
ok( 'the front end does not match', '' === skyphusion_product_headroom_script() );

echo $fails . " failing\n";
exit( $fails ? 1 : 0 );
