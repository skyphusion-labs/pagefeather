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
function post_message_to_js( $json ) { $GLOBALS['handoff'][] = $json; return isset( $GLOBALS['reply'] ) ? $GLOBALS['reply'] : '{"ok":true,"queued":true}'; }
// #1135: the Worker's reply decides the return; a refusal fires wp_mail_failed as core does.
$GLOBALS['failed'] = array();
function do_action( $hook, $arg = null ) { if ( 'wp_mail_failed' === $hook ) { $GLOBALS['failed'][] = $arg; } }
class WP_Error {
	public $code; public $message; public $data;
	function __construct( $code, $message, $data = null ) { $this->code = $code; $this->message = $message; $this->data = $data; }
	function get_error_message() { return $this->message; }
	function get_error_data() { return $this->data; }
}
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

// #1135: a send the platform refused must not be reported as delivered (WP Mail Logging, wp_mail_failed listeners).
unset( $GLOBALS['filter_cb']['pre_wp_mail'] );
$GLOBALS['failed'] = array();
$GLOBALS['reply'] = '{"ok":true,"queued":true,"refused":1,"of":1,"reason":"destination address is not allowed"}';
$result = wp_mail( 'customer@example.com', 'Password Reset', 'Body' );
ok( '#1135 a refused send returns false', false === $result );
ok( '#1135 a refused send fires wp_mail_failed once', 1 === count( $GLOBALS['failed'] ) );
$e = $GLOBALS['failed'] ? $GLOBALS['failed'][0] : null;
ok( '#1135 the error code is core\'s', $e && 'wp_mail_failed' === $e->code );
ok( '#1135 the message names the refusal and its reason', $e && false !== strpos( $e->message, 'refused' ) && false !== strpos( $e->message, 'destination address is not allowed' ) );
ok( '#1135 the message says it is queued for retry', $e && false !== strpos( $e->message, 'retry' ) );
ok( '#1135 the data carries the mail, as core does', $e && is_array( $e->data ) && 'Password Reset' === $e->data['subject'] && array( 'customer@example.com' ) === (array) $e->data['to'] );

$GLOBALS['failed'] = array();
$GLOBALS['reply'] = '{"ok":false,"error":"retry store write failed"}';
$result = wp_mail( 'customer@example.com', 'Order', 'Body' );
ok( '#1135 a failed handoff returns false', false === $result );
ok( '#1135 a failed handoff fires wp_mail_failed', 1 === count( $GLOBALS['failed'] ) && false !== strpos( $GLOBALS['failed'][0]->message, 'retry store write failed' ) );

$GLOBALS['failed'] = array();
$GLOBALS['reply'] = '{"ok":true,"queued":true}';
ok( '#1135 a queued or sent mail stays true', true === wp_mail( 'mackaye@example.com', 'Order', 'Body' ) );
ok( '#1135 and fires nothing', 0 === count( $GLOBALS['failed'] ) );

$GLOBALS['reply'] = '';
ok( '#1135 no readable reply (an older Worker) stays true, as before', true === wp_mail( 'mackaye@example.com', 'Order', 'Body' ) && 0 === count( $GLOBALS['failed'] ) );
unset( $GLOBALS['reply'] );

echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
exit( $fail ? 1 : 0 );
