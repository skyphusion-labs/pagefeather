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

echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
exit( $fail ? 1 : 0 );
