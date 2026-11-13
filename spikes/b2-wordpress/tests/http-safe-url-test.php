<?php
// php spikes/b2-wordpress/tests/http-safe-url-test.php (issue #430)
// skyphusion_http_validate_url(): core's wp_http_validate_url() checks without DNS. Public names
// pass (the wp-admin plugin download), and what core refuses, or what cannot be checked without
// DNS, is refused. Minimal WordPress stubs; the real file is loaded.
$fail = 0;
function check( $label, $got, $want ) {
	global $fail;
	if ( $got === $want ) { echo "ok   $label\n"; return; }
	$fail++; echo "FAIL $label\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
}
function post_message_to_js( $j ) { return '{}'; }
function add_filter( ...$a ) {}
function get_option( $k ) { return 'home' === $k ? 'https://shop.example.com:8443' : false; }
$GLOBALS['external'] = false;
$GLOBALS['ports']    = null;
function apply_filters( $hook, $value, ...$args ) {
	if ( 'http_request_host_is_external' === $hook ) { return $GLOBALS['external']; }
	if ( 'http_allowed_safe_ports' === $hook && null !== $GLOBALS['ports'] ) { return $GLOBALS['ports']; }
	return $value;
}
function wp_kses_bad_protocol( $s, $allowed ) {
	$scheme = strtolower( (string) parse_url( $s, PHP_URL_SCHEME ) );
	return in_array( $scheme, $allowed, true ) ? $s : preg_replace( '#^[a-z]+:#i', '', $s );
}
require __DIR__ . '/../php/http-bridge.php';

$v = 'skyphusion_http_validate_url';
$dl = 'https://downloads.wordpress.org/plugin/hello-dolly.1.7.2.zip';
check( 'the wp-admin plugin download passes (the #430 failure)', $v( $dl ), $dl );
check( 'a public IP literal passes', $v( 'https://1.1.1.1/x' ), 'https://1.1.1.1/x' );
check( 'port 8080 passes (core safe port)', $v( 'http://api.example.com:8080/' ), 'http://api.example.com:8080/' );
check( 'the site itself on its own port passes', $v( 'https://shop.example.com:8443/wp-json/' ), 'https://shop.example.com:8443/wp-json/' );
foreach ( array(
	'not a string'                 => 42,
	'empty'                        => '',
	'numeric'                      => '123',
	'ftp scheme'                   => 'ftp://example.com/x',
	'file scheme'                  => 'file:///etc/passwd',
	'no host'                      => 'https:///x',
	'user and password'            => 'https://u:p@example.com/',
	'odd host characters'          => 'https://exa[mple.com/',
	'loopback IP'                  => 'http://127.0.0.1/',
	'10/8'                         => 'http://10.1.2.3/',
	'172.16/12'                    => 'http://172.20.0.1/',
	'192.168/16'                   => 'http://192.168.1.1/',
	'0/8'                          => 'http://0.0.0.0/',
	'link-local metadata 169.254'  => 'http://169.254.169.254/latest/meta-data/',
	'localhost'                    => 'http://localhost/',
	'a .localhost name'            => 'http://api.localhost/',
	'a .local name'                => 'http://printer.local/',
	'a .internal name'             => 'http://worker.internal/',
	'a name with no dot'           => 'http://intranet/',
	'an unsafe port'               => 'https://example.com:22/',
	'the site host on another port' => 'https://shop.example.com:9999/',
) as $label => $url ) {
	check( "refused: $label", $v( $url ), false );
}
$GLOBALS['external'] = true;
check( 'http_request_host_is_external can allow a private host', $v( 'http://10.1.2.3/' ), 'http://10.1.2.3/' );
check( 'and a non-public name', $v( 'http://intranet/' ), 'http://intranet/' );
$GLOBALS['external'] = false;
$GLOBALS['ports']    = array( 443, 22 );
check( 'http_allowed_safe_ports widens the ports', $v( 'https://example.com:22/' ), 'https://example.com:22/' );
echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
exit( $fail ? 1 : 0 );
