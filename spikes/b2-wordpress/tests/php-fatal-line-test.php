<?php
/**
 * #1153: php/php-fatal-line.php. WordPress answered 500 on themes.php (cf759hw, ray a5d966de78399318) with no engine
 * line, so the cause could not be read. A PHP fatal (or a 500 wp_die) now reaches the Worker as one line: the type, the
 * message (addresses and URLs scrubbed, 300 chars), the file below /wordpress, the line, and the request path (no query).
 * Run: php spikes/b2-wordpress/tests/php-fatal-line-test.php
 */
$GLOBALS['bridge'] = array(); $GLOBALS['filters'] = array();
function post_message_to_js( $j ) { $GLOBALS['bridge'][] = json_decode( $j, true ); return '1'; }
function add_filter( $h, $cb, $p = 10, $n = 1 ) { $GLOBALS['filters'][ $h ] = $cb; return true; }
function wp_parse_url( $u, $c = -1 ) { return parse_url( $u, $c ); }
$_SERVER['REQUEST_URI'] = '/wp-admin/themes.php?action=activate&stylesheet=emptytheme&_wpnonce=abc123';
$_SERVER['REQUEST_METHOD'] = 'GET';
require __DIR__ . '/../php/php-fatal-line.php';
// Keep headers unsent so a later http_response_code() still sticks (#1220). The
// reopen cases read that status. Without this buffer the first PASS line sends
// headers, and the status can no longer change.
ob_start();
$fail = 0;
function ok( $l, $c ) { global $fail; echo ( $c ? 'PASS ' : 'FAIL ' ) . $l . "\n"; if ( ! $c ) { $fail++; } }

skyphusion_php_fatal_report( array( 'type' => E_ERROR, 'message' => "Uncaught TypeError: x(): Argument #1 must be of type array, null given, called for admin@example.com at https://site.example/wp-admin/x?k=SECRET", 'file' => '/wordpress/wp-content/themes/emptytheme/functions.php', 'line' => 42 ) );
$m = $GLOBALS['bridge'] ? $GLOBALS['bridge'][0]['phpFatal'] : null;
ok( 'a fatal reaches the Worker', is_array( $m ) && E_ERROR === $m['type'] );
ok( 'the message is kept, with the address and the URL scrubbed', $m && false !== strpos( $m['msg'], 'Uncaught TypeError' ) && false === strpos( $m['msg'], 'admin@example.com' ) && false === strpos( $m['msg'], 'SECRET' ) && false !== strpos( $m['msg'], '[address]' ) && false !== strpos( $m['msg'], '[url]' ) );
ok( 'the file is below /wordpress, and the line', $m && 'wp-content/themes/emptytheme/functions.php' === $m['file'] && 42 === $m['line'] );
ok( 'the path, without the query (no nonce)', $m && '/wp-admin/themes.php' === $m['path'] && 'GET' === $m['method'] );
$GLOBALS['bridge'] = array();
skyphusion_php_fatal_report( array( 'type' => E_WARNING, 'message' => 'w', 'file' => '/wordpress/x.php', 'line' => 1 ) );
ok( 'a warning is not a fatal: nothing sent', array() === $GLOBALS['bridge'] );
skyphusion_php_fatal_report( null );
ok( 'no error: nothing sent', array() === $GLOBALS['bridge'] );
skyphusion_php_fatal_report( array( 'type' => E_ERROR, 'message' => str_repeat( 'a', 1000 ), 'file' => '/wordpress/y.php', 'line' => 2 ) );
ok( 'the message is at most 300 characters', strlen( $GLOBALS['bridge'][0]['phpFatal']['msg'] ) <= 300 );

// A 500 wp_die (WordPress can fail a request without a PHP fatal): the wrapped handler reports it, then dies as before.
$GLOBALS['bridge'] = array();
$GLOBALS['died'] = 0;
$wrap = $GLOBALS['filters']['wp_die_handler'];
$h = $wrap( function () { $GLOBALS['died']++; } );
$h( 'The theme directory "emptytheme" does not exist.', 'Error', array( 'response' => 500 ) );
$d = $GLOBALS['bridge'] ? $GLOBALS['bridge'][0]['phpFatal'] : null;
ok( 'a 500 wp_die is reported (type wp_die, the message)', is_array( $d ) && 'wp_die' === $d['type'] && false !== strpos( $d['msg'], 'emptytheme' ) && 500 === $d['status'] );
ok( 'and the original handler still runs', 1 === $GLOBALS['died'] );
$GLOBALS['bridge'] = array();
$h( 'Sorry, you are not allowed.', 'Error', array( 'response' => 403 ) );
ok( 'a non-500 wp_die is not reported', array() === $GLOBALS['bridge'] );

// #1220: wp_send_json() ends with wp_die( '', '', array( 'response' => null ) ). The client gets 200 and the JSON.
// A response of null or 200 is that normal exit, not a fatal. A real 500, even with an empty message, still is.
$GLOBALS['bridge'] = array();
$died_before = $GLOBALS['died'];
$h( '', '', array( 'response' => null ) );
ok( 'a wp_die with response null (wp_send_json) is not a php-fatal', array() === $GLOBALS['bridge'] );
ok( 'and the original handler still runs for that exit', $GLOBALS['died'] === $died_before + 1 );
$GLOBALS['bridge'] = array();
$h( '', '', array( 'response' => 200 ) );
ok( 'a wp_die with response 200 is not a php-fatal', array() === $GLOBALS['bridge'] );
$GLOBALS['bridge'] = array();
$h( '', '', array( 'response' => 500 ) );
$e = $GLOBALS['bridge'] ? $GLOBALS['bridge'][0]['phpFatal'] : null;
ok( 'a 500 wp_die with an empty message is still a fatal', is_array( $e ) && 'wp_die' === $e['type'] && '' === $e['msg'] && 500 === $e['status'] );

// #1220 reopen: admin-ajax.php ends with wp_die() and no response key
// (sample-permalink, woocommerce_add_attribute, oembed-cache). The answer is
// 200 with content. That die is not a 500. A real 5xx still is. The status
// comes from http_response_code(), not from the action name.
$_SERVER['REQUEST_URI']    = '/wp-admin/admin-ajax.php?action=sample-permalink';
$_SERVER['REQUEST_METHOD'] = 'POST';
http_response_code( 200 );
$GLOBALS['bridge'] = array();
$ajax_wrap         = $GLOBALS['filters']['wp_die_ajax_handler'];
$ajax              = $ajax_wrap( function () { $GLOBALS['died']++; } );
$died_ajax         = $GLOBALS['died'];
$ajax( 'permalink html', '', array() );
ok( 'a wp_die with no response key on admin-ajax at status 200 is not a php-fatal', array() === $GLOBALS['bridge'] );
ok( 'and the original ajax handler still runs', $GLOBALS['died'] === $died_ajax + 1 );
$GLOBALS['bridge'] = array();
$ajax( 'broken', '', array( 'response' => 500 ) );
$ajax500 = $GLOBALS['bridge'] ? $GLOBALS['bridge'][0]['phpFatal'] : null;
ok( 'a wp_die with response 500 on admin-ajax is still a php-fatal', is_array( $ajax500 ) && 'wp_die' === $ajax500['type'] && 500 === $ajax500['status'] && false !== strpos( $ajax500['msg'], 'broken' ) && '/wp-admin/admin-ajax.php' === $ajax500['path'] );
http_response_code( 503 );
$GLOBALS['bridge'] = array();
$ajax( 'down', '', array() );
$real503 = $GLOBALS['bridge'] ? $GLOBALS['bridge'][0]['phpFatal'] : null;
ok( 'a wp_die with no response key at status 503 is a php-fatal with that status', is_array( $real503 ) && 'wp_die' === $real503['type'] && 503 === $real503['status'] && false !== strpos( $real503['msg'], 'down' ) );

// The Ajax handler sets 200 when the key is absent, even if an older status was 500.
// The default handler sets 500. Read the status after the handler, not the action name.
$ajax_sets_200 = $ajax_wrap( function () {
	$GLOBALS['died']++;
	http_response_code( 200 );
} );
http_response_code( 500 );
$GLOBALS['bridge'] = array();
$died_ajax         = $GLOBALS['died'];
$ajax_sets_200( 'attribute row', '', array() );
ok( 'a wp_die with no response key is not a php-fatal when the ajax handler sets 200', array() === $GLOBALS['bridge'] );
ok( 'and that ajax handler still runs', $GLOBALS['died'] === $died_ajax + 1 );
$die_sets_500 = $GLOBALS['filters']['wp_die_handler'];
$sets_500     = $die_sets_500( function () {
	$GLOBALS['died']++;
	http_response_code( 500 );
} );
http_response_code( 200 );
$GLOBALS['bridge'] = array();
$sets_500( 'The theme directory "emptytheme" does not exist.', 'Error', array() );
$handler500 = $GLOBALS['bridge'] ? $GLOBALS['bridge'][0]['phpFatal'] : null;
ok( 'a wp_die with no response key is a fatal when the handler sets 500', is_array( $handler500 ) && 'wp_die' === $handler500['type'] && 500 === $handler500['status'] && false !== strpos( $handler500['msg'], 'emptytheme' ) );
http_response_code( 200 );

if ( ob_get_level() > 0 ) {
	ob_end_flush();
}
echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
exit( $fail ? 1 : 0 );
