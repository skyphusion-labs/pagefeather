<?php
/**
 * #913: php/wp-mail-queue.php runs the wp_mail filter before the handoff.
 * WP Mail Logging 1.17 records the message on that filter. A pre_wp_mail
 * answer is returned and is not handed off.
 * Run: php spikes/b2-wordpress/tests/wp-mail-queue-test.php
 */
$GLOBALS['filters'] = array();
$GLOBALS['handoff'] = array();
$GLOBALS['hooks']   = array();
function add_action( $h, $cb, $p = 10, $n = 1 ) { $GLOBALS['hooks'][] = $h; return true; }
function apply_filters( $hook, $value ) {
	$GLOBALS['filters'][] = $hook;
	if ( isset( $GLOBALS['filter_cb'][ $hook ] ) ) {
		return call_user_func( $GLOBALS['filter_cb'][ $hook ], $value );
	}
	return $value;
}
function post_message_to_js( $json ) { $GLOBALS['handoff'][] = $json; }
function wp_json_encode( $v ) { return json_encode( $v ); }
define( 'SKYPHUSION_ASYNC_EMAIL', true );
require __DIR__ . '/../php/wp-mail-queue.php';

$fail = 0;
function ok( $label, $cond ) {
	global $fail;
	echo ( $cond ? 'PASS ' : 'FAIL ' ) . $label . "\n";
	if ( ! $cond ) { $fail++; }
}

$GLOBALS['filter_cb']['wp_mail'] = function ( $atts ) {
	$GLOBALS['seen'] = $atts;
	return $atts;
};
$result = wp_mail( 'ada@example.com', 'Hello', 'Body', '', array() );
ok( 'filter ran', in_array( 'wp_mail', $GLOBALS['filters'], true ) );
ok( 'pre_wp_mail ran', in_array( 'pre_wp_mail', $GLOBALS['filters'], true ) );
ok( 'returns true', true === $result );
ok( 'one handoff', 1 === count( $GLOBALS['handoff'] ) );
ok( 'log saw the subject', isset( $GLOBALS['seen']['subject'] ) && 'Hello' === $GLOBALS['seen']['subject'] );

$GLOBALS['filters'] = array();
$GLOBALS['handoff'] = array();
$GLOBALS['filter_cb']['pre_wp_mail'] = function () { return false; };
$result = wp_mail( 'ada@example.com', 'Stop', 'Body' );
ok( 'pre_wp_mail false is returned', false === $result );
ok( 'pre_wp_mail skips the handoff', 0 === count( $GLOBALS['handoff'] ) );

echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
exit( $fail ? 1 : 0 );
