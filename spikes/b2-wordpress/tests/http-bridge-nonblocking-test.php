<?php
// php spikes/b2-wordpress/tests/http-bridge-nonblocking-test.php (#1215)
// A non-blocking wp_remote_*() (blocking => false) is fire-and-forget in core: WP_Http::request() sends it and returns
// an empty response at once, and the far end runs to completion. Action Scheduler's async queue runner is one (a
// loopback POST to admin-ajax.php, timeout 0.01); it is how a due action, such as a deferred order email, runs within
// a second of an admin request. The bridge ignored 'blocking' and awaited the answer under a 1 s floor, so the
// loopback was cut off and the email waited for the cron alarm (12 to 122 s on cf759hl).
// Minimal WordPress stubs; the real file is loaded and its pre_http_request callback is driven.
$fail = 0;
function check( $label, $got, $want ) {
	global $fail;
	if ( $got === $want ) { echo "ok   $label\n"; return; }
	$fail++; echo "FAIL $label\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
}
$GLOBALS['sent'] = array(); $GLOBALS['reply'] = '{}'; $GLOBALS['debug'] = 0; $GLOBALS['filtered'] = 0;
function post_message_to_js( $j ) { $GLOBALS['sent'][] = json_decode( $j, true ); return $GLOBALS['reply']; }
$GLOBALS['cb'] = null;
function add_filter( $h, $cb = null, ...$a ) { if ( 'pre_http_request' === $h ) { $GLOBALS['cb'] = $cb; } }
function get_option( $k ) { return 'home' === $k ? 'https://shop.example.com' : 'UTF-8'; }
function apply_filters( $hook, $value, ...$args ) { if ( 'http_response' === $hook ) { ++$GLOBALS['filtered']; } return $value; }
function do_action( $hook, ...$a ) { if ( 'http_api_debug' === $hook ) { ++$GLOBALS['debug']; } }
function wp_kses_bad_protocol( $s, $allowed ) { return $s; }
function wp_parse_url( $u, $c = -1 ) { return parse_url( $u, $c ); }
function __( $s ) { return $s; }
function get_status_header_desc( $c ) { return 'OK'; }
class WP_Error { public $code; public $message; function __construct( $c, $m ) { $this->code = $c; $this->message = $m; } }
class WP_Http_Cookie { function __construct( $v, $u ) {} }
class WP_Http { static function processHeaders( $h ) { return array( 'headers' => array() ); } }
class Skyphusion_Test_Http { function block_request( $u ) { return false; } }
function _wp_http_get_object() { return new Skyphusion_Test_Http(); }
require __DIR__ . '/../php/http-bridge.php';
$base = array( 'method' => 'POST', 'headers' => array(), 'cookies' => array(), 'body' => array( 'action' => 'as_async_request_queue_runner' ), 'user-agent' => 'WordPress', 'timeout' => 0.01, 'redirection' => 5, 'limit_response_size' => null, 'stream' => false, 'filename' => null, 'reject_unsafe_urls' => false );
$cb  = $GLOBALS['cb'];
$url = 'https://shop.example.com/wp-admin/admin-ajax.php?action=as_async_request_queue_runner';

// non-blocking: the Worker is told, and core's empty non-blocking response comes back at once
$GLOBALS['reply'] = '{"queued":true}';
$r = $cb( false, $base + array( 'blocking' => false ), $url );
check( 'non-blocking: the bridge sends blocking false', $GLOBALS['sent'][0]['http']['blocking'] ?? null, false );
check( 'non-blocking: core empty response (WP_Http::request, blocking false)', $r, array( 'headers' => array(), 'body' => '', 'response' => array( 'code' => false, 'message' => false ), 'cookies' => array(), 'http_response' => null ) );
check( '  http_api_debug fires, the http_response filter does not (as core)', array( $GLOBALS['debug'], $GLOBALS['filtered'] ), array( 1, 0 ) );
// a refusal the Worker makes before sending is still an error
$GLOBALS['reply'] = '{"error":"host not in HTTP_ALLOW_HOSTS: x"}';
$r = $cb( false, $base + array( 'blocking' => false ), $url );
check( 'non-blocking, refused before sending: a WP_Error', $r instanceof WP_Error ? $r->message : $r, 'host not in HTTP_ALLOW_HOSTS: x' );
// stream forces blocking, as core does (class-wp-http.php: a streamed response must be written)
$GLOBALS['sent'] = array(); $GLOBALS['reply'] = '{"status":200,"statusText":"OK","headers":[],"body":""}';
$cb( false, array_merge( $base, array( 'blocking' => false, 'stream' => true, 'filename' => sys_get_temp_dir() . '/pf1215-' . getmypid() ) ), $url );
check( 'stream: sent as blocking', $GLOBALS['sent'][0]['http']['blocking'] ?? null, true );
@unlink( sys_get_temp_dir() . '/pf1215-' . getmypid() );
// blocking (the default): unchanged, the answer is returned
$GLOBALS['sent'] = array(); $GLOBALS['debug'] = 0; $GLOBALS['filtered'] = 0;
$r = $cb( false, $base + array( 'blocking' => true ), $url );
check( 'blocking: sent as blocking', $GLOBALS['sent'][0]['http']['blocking'] ?? null, true );
check( 'blocking: the answer, through http_response', array( $r['response']['code'], $GLOBALS['filtered'] ), array( 200, 1 ) );
echo $fail ? "$fail FAILED\n" : "ALL PASS\n";
exit( $fail ? 1 : 0 );
