<?php
/**
 * Comment REST writes free allocator caches and cap the object cache (#989).
 *
 * A block note save on a hot editor runtime resets the isolate.
 * The mu-plugin does not unload WooCommerce.
 * A review route under /wc does not match.
 *
 * Run: php spikes/b2-wordpress/tests/comment-rest-headroom-test.php
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
$php  = file_get_contents( $root . '/php/comment-rest-headroom.php' );
$idx  = file_get_contents( $root . '/index.js' );
$bld  = file_get_contents( $root . '/build.sh' );
ok( 'the gate returns when the constant is off', false !== strpos( $php, "if ( ! defined( 'SKYPHUSION_COMMENT_HEADROOM' ) || ! SKYPHUSION_COMMENT_HEADROOM ) {\n\treturn;\n}" ) );
ok( 'index.js defines the gate on b-dosql', false !== strpos( $idx, "define('SKYPHUSION_COMMENT_HEADROOM', true)" ) );
ok( 'index.js honors COMMENT_HEADROOM=off', false !== strpos( $idx, "ENV.COMMENT_HEADROOM !== 'off'" ) );
ok( 'build.sh copies the mu-plugin', false !== strpos( $bld, 'php/comment-rest-headroom.php' ) );
ok( 'a non-matching request returns before the hooks', false !== strpos( $php, "if ( '' === skyphusion_comment_headroom_route() ) {\n\treturn;\n}" ) );
ok( 'WooCommerce stays loaded', false === strpos( $php, 'option_active_plugins' ) );
ok( 'the cap is 1 MiB', false !== strpos( $php, "'n' => 1048576" ) );
ok( 'plain permalinks are in the matcher', false !== strpos( $php, '/index.php/wp-json/wp/v2/comments' ) );

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

define( 'SKYPHUSION_COMMENT_HEADROOM', true );
$_SERVER['REQUEST_URI'] = '/index.php/wp-json/wp/v2/comments?_locale=user';
$GLOBALS['wp_object_cache'] = new stdClass();
require $root . '/php/comment-rest-headroom.php';

ok( 'a plain permalink note create matches', '/wp/v2/comments' === skyphusion_comment_headroom_route() );
ok( 'sent the 1 MiB cap', isset( $GLOBALS['msgs'][0] ) && false !== strpos( $GLOBALS['msgs'][0], '"n":1048576' ) && false !== strpos( $GLOBALS['msgs'][0], '"op":"cap"' ) );
ok( 'flushed the object cache', 1 === $GLOBALS['flushed'] );
ok( 'frees caches again at plugins_loaded', isset( $GLOBALS['actions']['plugins_loaded'] ) && 0 === $GLOBALS['actions']['plugins_loaded'][0][1] );

$_SERVER['REQUEST_URI'] = '/index.php/wp-json/wp/v2/comments/316?force=true';
ok( 'a plain permalink comment id matches', '/wp/v2/comments/316' === skyphusion_comment_headroom_route() );
$_SERVER['REQUEST_URI'] = '/?rest_route=/wp/v2/comments';
ok( 'rest_route matches', '/wp/v2/comments' === skyphusion_comment_headroom_route() );
$_SERVER['REQUEST_URI'] = '/wp-json/wp/v2/comments';
ok( 'a pretty comments route matches', '/wp/v2/comments' === skyphusion_comment_headroom_route() );
$_SERVER['REQUEST_URI'] = '/index.php/wp-json/wc/v3/products/reviews';
ok( 'a WooCommerce review route does not match', '' === skyphusion_comment_headroom_route() );
$_SERVER['REQUEST_URI'] = '/index.php/wp-json/wp/v2/users/me?_locale=user';
ok( 'users/me does not match', '' === skyphusion_comment_headroom_route() );
$_SERVER['REQUEST_URI'] = '/wp-admin/post-new.php';
ok( 'post-new.php does not match', '' === skyphusion_comment_headroom_route() );
$_SERVER['REQUEST_URI'] = '/index.php/wp-json/wp/v2/comments-extra';
ok( 'a lookalike path does not match', '' === skyphusion_comment_headroom_route() );

echo $fails . " failing\n";
exit( $fails ? 1 : 0 );
