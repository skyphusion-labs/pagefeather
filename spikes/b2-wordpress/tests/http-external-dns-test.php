<?php
/**
 * #1156: php/http-external-dns.php. Core's wp_http_validate_url asks the http_request_host_is_external filter when a
 * host resolves to a private-looking address. Inside the engine every name resolves to emscripten's synthetic
 * 172.29.x.x, so the plugin asks the Worker to resolve it for real (dnsPublic) and answers its verdict. A real private
 * address, or a literal IP, keeps core's answer.
 * Run: php spikes/b2-wordpress/tests/http-external-dns-test.php
 */
$GLOBALS['filters'] = array(); $GLOBALS['asked'] = array(); $GLOBALS['verdict'] = '1'; $GLOBALS['resolve'] = array();
function add_filter( $h, $cb, $p = 10, $n = 1 ) { $GLOBALS['filters'][ $h ] = $cb; return true; }
function post_message_to_js( $j ) { $d = json_decode( $j, true ); $GLOBALS['asked'][] = $d; return $GLOBALS['verdict']; }
// gethostbyname is a builtin: the plugin calls it through a seam the test can set.
function skyphusion_test_resolve( $h ) { return isset( $GLOBALS['resolve'][ $h ] ) ? $GLOBALS['resolve'][ $h ] : $h; }
define( 'SKYPHUSION_DNS_RESOLVER', 'skyphusion_test_resolve' );
require __DIR__ . '/../php/http-external-dns.php';
$f = $GLOBALS['filters']['http_request_host_is_external'];
$fail = 0;
function ok( $l, $c ) { global $fail; echo ( $c ? 'PASS ' : 'FAIL ' ) . $l . "\n"; if ( ! $c ) { $fail++; } }

$GLOBALS['resolve'] = array( 'cldup.com' => '172.29.1.0', 'intranet.local' => '10.0.0.5', 'evil.example' => '172.29.3.0' );
$GLOBALS['verdict'] = '1';
ok( 'a synthetic address, the Worker says public: external', true === $f( false, 'cldup.com', 'https://cldup.com/x.jpg' ) );
ok( 'it asked the Worker about that host', isset( $GLOBALS['asked'][0]['dnsPublic']['host'] ) && 'cldup.com' === $GLOBALS['asked'][0]['dnsPublic']['host'] );
$GLOBALS['verdict'] = '0'; $GLOBALS['asked'] = array();
ok( 'a synthetic address, the Worker says not public: still refused', false === $f( false, 'evil.example', 'https://evil.example/' ) );
$GLOBALS['asked'] = array();
ok( 'a REAL private address (not the synthetic range): core keeps its refusal, no lookup', false === $f( false, 'intranet.local', 'http://intranet.local/' ) && array() === $GLOBALS['asked'] );
ok( 'a literal IP: core keeps its answer, no lookup', false === $f( false, '10.0.0.5', 'http://10.0.0.5/' ) && array() === $GLOBALS['asked'] );
ok( 'already external (another plugin said so): kept', true === $f( true, 'intranet.local', 'http://intranet.local/' ) );
$GLOBALS['verdict'] = 'garbage';
ok( 'an unreadable answer is not external', false === $f( false, 'cldup.com', 'https://cldup.com/' ) );

echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
exit( $fail ? 1 : 0 );
