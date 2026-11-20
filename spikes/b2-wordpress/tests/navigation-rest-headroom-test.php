<?php
/**
 * Navigation REST writes free allocator caches and cap the object cache (#993).
 *
 * A suite-hot runtime resets on a navigation create.
 * A force delete and a batch call fail the same way.
 * The mu-plugin does not unload WooCommerce.
 * A GET list does not match. A comment route does not match.
 *
 * Run: php spikes/b2-wordpress/tests/navigation-rest-headroom-test.php
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
$php  = file_get_contents( $root . '/php/navigation-rest-headroom.php' );
$idx  = file_get_contents( $root . '/index.js' );
$bld  = file_get_contents( $root . '/build.sh' );
ok( 'the gate returns when the constant is off', false !== strpos( $php, "if ( ! defined( 'SKYPHUSION_NAV_HEADROOM' ) || ! SKYPHUSION_NAV_HEADROOM ) {\n\treturn;\n}" ) );
ok( 'index.js defines the gate on b-dosql', false !== strpos( $idx, "define('SKYPHUSION_NAV_HEADROOM', true)" ) );
ok( 'index.js honors NAV_HEADROOM=off', false !== strpos( $idx, "ENV.NAV_HEADROOM !== 'off'" ) );
ok( 'build.sh copies the mu-plugin', false !== strpos( $bld, 'php/navigation-rest-headroom.php' ) );
ok( 'a non-matching request returns before the hooks', false !== strpos( $php, "if ( '' === skyphusion_nav_headroom_route() ) {\n\treturn;\n}" ) );
ok( 'WooCommerce stays loaded', false === strpos( $php, 'option_active_plugins' ) );
ok( 'the cap is 1 MiB', false !== strpos( $php, "'n' => 1048576" ) );
ok( 'plain permalinks are in the matcher', false !== strpos( $php, '/index.php/wp-json/' ) );

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

define( 'SKYPHUSION_NAV_HEADROOM', true );
$_SERVER['REQUEST_METHOD'] = 'POST';
$_SERVER['REQUEST_URI']    = '/wp-json/wp/v2/navigation';
$GLOBALS['wp_object_cache'] = new stdClass();
require $root . '/php/navigation-rest-headroom.php';

ok( 'a navigation create matches', '/wp/v2/navigation' === skyphusion_nav_headroom_route() );
ok( 'sent the 1 MiB cap', isset( $GLOBALS['msgs'][0] ) && false !== strpos( $GLOBALS['msgs'][0], '"n":1048576' ) && false !== strpos( $GLOBALS['msgs'][0], '"op":"cap"' ) );
ok( 'flushed the object cache', 1 === $GLOBALS['flushed'] );
ok( 'frees caches again at plugins_loaded', isset( $GLOBALS['actions']['plugins_loaded'] ) && 0 === $GLOBALS['actions']['plugins_loaded'][0][1] );

$_SERVER['REQUEST_METHOD'] = 'POST';
$_SERVER['REQUEST_URI']    = '/index.php/wp-json/wp/v2/navigation';
ok( 'a plain permalink navigation create matches', '/wp/v2/navigation' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_URI'] = '/?rest_route=/wp/v2/navigation';
ok( 'rest_route navigation create matches', '/wp/v2/navigation' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_METHOD'] = 'DELETE';
$_SERVER['REQUEST_URI']    = '/wp-json/wp/v2/navigation/4000?force=true';
ok( 'a navigation force delete matches', '/wp/v2/navigation/4000' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_URI'] = '/index.php/wp-json/wp/v2/posts/3999?force=true';
ok( 'a plain permalink post force delete matches', '/wp/v2/posts/3999' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_URI'] = '/wp-json/wp/v2/pages/3971?force=true';
ok( 'a page force delete matches', '/wp/v2/pages/3971' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_METHOD'] = 'OPTIONS';
$_SERVER['REQUEST_URI']    = '/wp-json/batch/v1';
ok( 'batch OPTIONS matches', '/batch/v1' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_METHOD'] = 'POST';
$_SERVER['REQUEST_URI']    = '/index.php/wp-json/batch/v1';
ok( 'a plain permalink batch POST matches', '/batch/v1' === skyphusion_nav_headroom_route() );

$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['REQUEST_URI']    = '/wp-json/wp/v2/navigation?context=edit&per_page=100';
ok( 'a navigation list does not match', '' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_METHOD'] = 'POST';
$_SERVER['REQUEST_URI']    = '/wp-json/wp/v2/posts';
ok( 'a post create does not match', '' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_METHOD'] = 'DELETE';
$_SERVER['REQUEST_URI']    = '/wp-json/wp/v2/posts';
ok( 'a post collection delete does not match', '' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_URI'] = '/wp-json/wp/v2/posts/3999/revisions?force=true';
ok( 'a revision delete does not match', '' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_METHOD'] = 'POST';
$_SERVER['REQUEST_URI']    = '/index.php/wp-json/wp/v2/comments';
ok( 'a comment route does not match', '' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_URI'] = '/index.php/wp-json/wc/v3/products';
ok( 'a WooCommerce product route does not match', '' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_URI'] = '/wp-json/wp/v2/users/me?_locale=user';
ok( 'users/me does not match', '' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['REQUEST_URI']    = '/wp-admin/themes.php';
ok( 'themes.php does not match', '' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['REQUEST_URI']    = '/wp-json/wp-block-editor/v1/navigation-fallback';
ok( 'navigation fallback does not match', '' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['REQUEST_URI']    = '/wp-json/batch/v1';
ok( 'a batch GET does not match', '' === skyphusion_nav_headroom_route() );
$_SERVER['REQUEST_METHOD'] = 'POST';
$_SERVER['REQUEST_URI']    = '/wp-json/batch/v1/extra';
ok( 'a batch lookalike does not match', '' === skyphusion_nav_headroom_route() );

echo $fails . " failing\n";
exit( $fails ? 1 : 0 );
