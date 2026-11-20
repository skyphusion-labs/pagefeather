<?php
/**
 * admin-ajax defers WooCommerce routes. REST does not (#963, #768).
 *
 * Run: php spikes/b2-wordpress/tests/wc-route-defer-scope-test.php
 */

$fails = 0;
function ok( $label, $cond ) {
	global $fails;
	echo ( $cond ? 'PASS ' : 'FAIL ' ) . $label . "\n";
	if ( ! $cond ) {
		$fails++;
	}
}

function add_action( $h, $cb, $prio = 10 ) {
	return true;
}
function add_filter( $h, $cb, $prio = 10 ) {
	return true;
}
function is_admin() {
	return ! empty( $GLOBALS['is_admin'] );
}
function wp_doing_ajax() {
	return ! empty( $GLOBALS['doing_ajax'] );
}

define( 'ABSPATH', __DIR__ );
$GLOBALS['is_admin']   = true;
$GLOBALS['doing_ajax'] = true;
$GLOBALS['pagenow']    = 'admin-ajax.php';
require dirname( __DIR__ ) . '/php/wc-route-defer.php';

ok( 'admin-ajax is in scope', Skyphusion_WC_Route_Defer::in_scope() );
$GLOBALS['doing_ajax'] = false;
$GLOBALS['pagenow']    = 'post.php';
ok( 'post.php is in scope', Skyphusion_WC_Route_Defer::in_scope() );
$GLOBALS['pagenow'] = 'post-new.php';
ok( 'post-new.php is in scope', Skyphusion_WC_Route_Defer::in_scope() );
$GLOBALS['pagenow'] = 'index.php';
ok( 'the dashboard is out of scope', ! Skyphusion_WC_Route_Defer::in_scope() );
$GLOBALS['is_admin'] = false;
$GLOBALS['pagenow']  = 'post.php';
ok( 'the front end is out of scope', ! Skyphusion_WC_Route_Defer::in_scope() );

$GLOBALS['is_admin']   = true;
$GLOBALS['doing_ajax'] = true;
define( 'REST_REQUEST', true );
ok( 'REST stays out of scope, even on ajax', ! Skyphusion_WC_Route_Defer::in_scope() );
$_SERVER['HTTP_X_PF_WC_DEFER'] = 'force';
ok( 'force still turns the defer on for a REST test', Skyphusion_WC_Route_Defer::in_scope() );

echo $fails . " failing\n";
exit( $fails ? 1 : 0 );
