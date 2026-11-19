<?php
/**
 * Application password REST calls do not load WooCommerce (php/app-password-headroom.php).
 *
 * A WooCommerce-warmed b-dosql isolate sits near the 128 MiB cap. The core
 * application-password write then resets the isolate. This route does not need
 * WooCommerce. The mu-plugin drops that one plugin and frees allocator caches.
 *
 * Run: php spikes/b2-wordpress/tests/app-password-headroom-test.php
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
$php  = file_get_contents( $root . '/php/app-password-headroom.php' );
$idx  = file_get_contents( $root . '/index.js' );
$bld  = file_get_contents( $root . '/build.sh' );
ok( 'the gate returns when the constant is off', false !== strpos( $php, "if ( ! defined( 'SKYPHUSION_APP_PASSWORD_HEADROOM' ) || ! SKYPHUSION_APP_PASSWORD_HEADROOM ) {\n\treturn;\n}" ) );
ok( 'index.js defines the gate on b-dosql', false !== strpos( $idx, "define('SKYPHUSION_APP_PASSWORD_HEADROOM', true)" ) );
ok( 'index.js honors APP_PASSWORD_HEADROOM=off', false !== strpos( $idx, "ENV.APP_PASSWORD_HEADROOM !== 'off'" ) );
ok( 'build.sh copies the mu-plugin', false !== strpos( $bld, 'php/app-password-headroom.php' ) );

$GLOBALS['filters'] = array();
$GLOBALS['actions'] = array();
function add_filter( $h, $cb, $prio = 10 ) {
	$GLOBALS['filters'][ $h ][] = array( $cb, $prio );
	return true;
}
function add_action( $h, $cb, $prio = 10 ) {
	$GLOBALS['actions'][ $h ][] = array( $cb, $prio );
	return true;
}

define( 'SKYPHUSION_APP_PASSWORD_HEADROOM', true );
$_SERVER['REQUEST_METHOD'] = 'POST';
$_SERVER['REQUEST_URI']    = '/wp-json/wp/v2/users/1/application-passwords?_locale=user';
unset( $_GET['rest_route'] );
require $root . '/php/app-password-headroom.php';

ok( 'hooks option_active_plugins', isset( $GLOBALS['filters']['option_active_plugins'] ) );
ok( 'frees caches again at plugins_loaded', isset( $GLOBALS['actions']['plugins_loaded'] ) );

$drop = $GLOBALS['filters']['option_active_plugins'][0][0];
$plugins = array(
	'woocommerce/woocommerce.php',
	'woocommerce-cleanup/woocommerce-cleanup.php',
	'wp-mail-logging/wp-mail-logging.php',
);
$kept = call_user_func( $drop, $plugins );
ok( 'drops woocommerce/ only', $kept === array( 'woocommerce-cleanup/woocommerce-cleanup.php', 'wp-mail-logging/wp-mail-logging.php' ) );
ok( 'a non-array plugin list is unchanged', 'nope' === call_user_func( $drop, 'nope' ) );

ok( 'POST users/1/application-passwords matches', '/wp/v2/users/1/application-passwords' === skyphusion_app_password_headroom_route() );
$_SERVER['REQUEST_URI'] = '/wp-json/wp/v2/users/me/application-passwords/abc-def?_locale=user';
ok( 'DELETE by uuid matches', '/wp/v2/users/me/application-passwords/abc-def' === skyphusion_app_password_headroom_route() );
$_SERVER['REQUEST_URI'] = '/index.php?rest_route=/wp/v2/users/me/application-passwords';
$_GET['rest_route']     = '/wp/v2/users/me/application-passwords';
ok( 'rest_route query matches', '/wp/v2/users/me/application-passwords' === skyphusion_app_password_headroom_route() );
unset( $_GET['rest_route'] );
$_SERVER['REQUEST_URI'] = '/wp-json/wp/v2/users/1';
ok( 'the user route does not match', '' === skyphusion_app_password_headroom_route() );
$_SERVER['REQUEST_URI'] = '/wp-json/wc/v3/system_status';
ok( 'a WooCommerce route does not match', '' === skyphusion_app_password_headroom_route() );
$_SERVER['REQUEST_URI'] = '/wp-admin/profile.php';
ok( 'profile.php does not match', '' === skyphusion_app_password_headroom_route() );
$_SERVER['REQUEST_URI'] = '/wp-json/wp/v2/users/1/application-passwords-extra';
ok( 'a longer name does not match', '' === skyphusion_app_password_headroom_route() );

echo $fails . " failing\n";
exit( $fails ? 1 : 0 );
