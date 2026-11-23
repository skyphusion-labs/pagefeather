<?php
// php spikes/b2-wordpress/tests/wc-download-path-test.php
// WooCommerce's force-download handler (WC_Download_Handler::download_file_force) resolves a downloadable file's URL
// with parse_file_path, then opens what it got. On this engine the uploads basedir is r2://uploads (php/r2-uploads.php),
// so parse_file_path turns https://<site>/wp-content/uploads/woocommerce_uploads/<f> into r2://uploads/woocommerce_uploads/<f>,
// sees a scheme that is not http, https or ftp, and keeps only the URL's PATH: "/woocommerce_uploads/<f>". That opens
// nothing, and the buyer gets "File not found". php/r2-uploads.php hooks woocommerce_download_parse_file_path (applied
// at the end of parse_file_path, AFTER WooCommerce's own permission checks in download()) to give the r2:// path back.
//
// parse_file_path below is WooCommerce 11.2.1's (includes/class-wc-download-handler.php), cut to the branches this
// engine reaches; the filter call at its end is WooCommerce's own.

ini_set( 'display_errors', '1' );
error_reporting( E_ALL );
$fail = 0;
function check( $label, $got, $want ) {
	global $fail;
	if ( $got === $want ) { echo "ok   $label\n"; return; }
	$fail++;
	echo "FAIL $label\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
}

// ---- In-memory R2, the same replies the Worker sends (as tests/upload-month-json-test.php). ----
$GLOBALS['pf_store'] = array();
function skyphusion_worker_call( $json ) {
	$op    = json_decode( $json, true )['r2'];
	$store = &$GLOBALS['pf_store'];
	if ( 'head' === $op['op'] ) {
		return json_encode( isset( $store[ $op['key'] ] ) ? array( 'ok' => true, 'found' => true, 'size' => strlen( $store[ $op['key'] ] ), 'mtime' => 1 ) : array( 'ok' => true, 'found' => false ) );
	}
	if ( 'list' === $op['op'] ) {
		$keys = array();
		foreach ( array_keys( $store ) as $k ) { if ( str_starts_with( $k, $op['prefix'] ) ) { $keys[] = $k; } }
		return json_encode( array( 'ok' => true, 'keys' => $keys, 'prefixes' => array() ) );
	}
	if ( 'get' === $op['op'] ) {
		if ( ! isset( $store[ $op['key'] ] ) ) { return json_encode( array( 'ok' => true, 'found' => false ) ); }
		$b = $store[ $op['key'] ];
		if ( isset( $op['offset'] ) || isset( $op['length'] ) ) { $b = substr( $b, (int) ( $op['offset'] ?? 0 ), isset( $op['length'] ) ? (int) $op['length'] : null ); }
		return json_encode( array( 'ok' => true, 'found' => true, 'body' => base64_encode( $b ), 'size' => strlen( $store[ $op['key'] ] ), 'mtime' => 1 ) );
	}
	return json_encode( array( 'ok' => false, 'error' => 'unknown r2 op' ) );
}

define( 'R2_UPLOADS', true );
define( 'ABSPATH', '/wordpress/' );
define( 'WP_CONTENT_DIR', '/wordpress/wp-content' );
$GLOBALS['hooks'] = array();
function add_filter( $hook, $cb, $prio = 10, $args = 1 ) { $GLOBALS['hooks'][ $hook ][] = array( $cb, $args ); }
function add_action( $hook, $cb, $prio = 10, $args = 1 ) {}
function apply_filters( $hook, $value, ...$more ) {
	foreach ( $GLOBALS['hooks'][ $hook ] ?? array() as $h ) { $value = ( $h[0] )( ...array_slice( array_merge( array( $value ), $more ), 0, max( 1, $h[1] ) ) ); }
	return $value;
}
function wp_die( $msg ) { fwrite( STDERR, "wp_die: $msg\n" ); exit( 1 ); }
require __DIR__ . '/../php/r2-uploads.php';

$SITE = 'https://shop.example';
function wp_upload_dir() {
	return apply_filters( 'upload_dir', array( 'path' => WP_CONTENT_DIR . '/uploads/2026/11', 'basedir' => WP_CONTENT_DIR . '/uploads', 'baseurl' => $GLOBALS['SITE'] . '/wp-content/uploads', 'url' => $GLOBALS['SITE'] . '/wp-content/uploads/2026/11', 'subdir' => '/2026/11', 'error' => false ) );
}
function wp_parse_url( $u ) { return parse_url( $u ); }

// WooCommerce 11.2.1 WC_Download_Handler::parse_file_path, the replacements and branches this engine reaches.
function wc_parse_file_path( $file_path ) {
	$wp_uploads   = wp_upload_dir();
	$replacements = array(
		$wp_uploads['baseurl'] => $wp_uploads['basedir'],
		$GLOBALS['SITE'] . '/'  => ABSPATH,
	);
	$count            = 0;
	$file_path        = str_replace( array_keys( $replacements ), array_values( $replacements ), $file_path, $count );
	$parsed_file_path = wp_parse_url( $file_path );
	$remote_file      = null === $count || 0 === $count;
	$wp_content_dirname = 'wp-content';
	if ( file_exists( ABSPATH . $file_path ) ) {
		$remote_file = false;
		$file_path   = ABSPATH . $file_path;
	} elseif ( 0 === strpos( $file_path, $wp_content_dirname ) ) {
		$remote_file = false;
		$file_path   = realpath( WP_CONTENT_DIR . substr( $file_path, strlen( $wp_content_dirname ) ) );
	} elseif ( ( ! isset( $parsed_file_path['scheme'] ) || ! in_array( $parsed_file_path['scheme'], array( 'http', 'https', 'ftp' ), true ) ) && isset( $parsed_file_path['path'] ) ) {
		$remote_file = false;
		$file_path   = $parsed_file_path['path'];
	}
	return array( 'remote_file' => $remote_file, 'file_path' => apply_filters( 'woocommerce_download_parse_file_path', $file_path, $remote_file ) );
}

// A paid file, stored where WooCommerce's upload_dir filter puts it.
$GLOBALS['pf_store']['uploads/woocommerce_uploads/2026/11/paid-a1b2.zip'] = 'PAID-BYTES-0123456789';

// 1. The buyer's file resolves to the r2:// path and opens, with the right bytes.
$p = wc_parse_file_path( $SITE . '/wp-content/uploads/woocommerce_uploads/2026/11/paid-a1b2.zip' );
check( 'buyer: resolved to the r2 path, local', $p, array( 'remote_file' => false, 'file_path' => 'r2://uploads/woocommerce_uploads/2026/11/paid-a1b2.zip' ) );
$h = @fopen( $p['file_path'], 'rb' );
check( 'buyer: the resolved path opens', false !== $h, true );
check( 'buyer: the bytes are the file', $h ? stream_get_contents( $h ) : null, 'PAID-BYTES-0123456789' );
check( 'buyer: filesize works for the range header', @filesize( $p['file_path'] ), 21 );

// 2. A file that is not in R2 is left as WooCommerce resolved it (it then answers "File not found").
$p = wc_parse_file_path( $SITE . '/wp-content/uploads/woocommerce_uploads/2026/11/missing.zip' );
check( 'missing: unchanged', $p['file_path'], '/woocommerce_uploads/2026/11/missing.zip' );

// 3. A remote file (another host) is left alone: the hook touches local paths only.
$p = wc_parse_file_path( 'https://cdn.other.example/file.zip' );
check( 'remote: unchanged and still remote', $p, array( 'remote_file' => true, 'file_path' => 'https://cdn.other.example/file.zip' ) );

// 4. A path that climbs out of uploads does not reach a key outside it.
$GLOBALS['pf_store']['_build/inputs.json'] = 'SECRET';
$p = wc_parse_file_path( $SITE . '/wp-content/uploads/../../_build/inputs.json' );
check( 'climb: not mapped to a key outside uploads', is_string( $p['file_path'] ) && false !== strpos( $p['file_path'], '_build' ) && ( $h = @fopen( $p['file_path'], 'rb' ) ) && 'SECRET' === stream_get_contents( $h ), false );

// 5. Even if a key with a literal ".." existed in R2, a ".." path is never mapped (the guard, not R2's literal keys).
$GLOBALS['pf_store']['uploads/../../_build/inputs.json'] = 'SECRET2';
$p = wc_parse_file_path( $SITE . '/wp-content/uploads/../../_build/inputs.json' );
check( 'climb with a literal key present: still not mapped to r2', 0 === strpos( (string) $p['file_path'], 'r2://' ), false );

echo $fail ? "\n$fail CHECK(S) FAILED\n" : "\nALL CHECKS PASS\n";
exit( $fail ? 1 : 0 );
