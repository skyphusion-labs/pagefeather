<?php
// php tests/r2-trace-test.php
// Issue #1424 step 1. The per-call R2 bridge trace in php/r2-uploads.php: with the operator header it records, per
// bridge call, the op, a key SHAPE (no file names, no dates), the ms, a dup count and the PHP callers; without the
// header it records and sends nothing. Same in-memory R2 as upload-month-json-test.php.

$case = getenv( 'PF_CASE' );
if ( false === $case || '' === $case ) {
	$fail = 0;
	foreach ( array( 'off', 'zero', 'empty', 'on' ) as $c ) {
		echo "== case: $c ==\n";
		passthru( 'PF_CASE=' . $c . ' ' . escapeshellarg( PHP_BINARY ) . ' ' . escapeshellarg( __FILE__ ), $code );
		if ( 0 !== $code ) {
			$fail++;
		}
	}
	echo $fail ? "\n$fail CASE(S) FAILED\n" : "\nALL CASES PASS\n";
	exit( $fail ? 1 : 0 );
}

$fail = 0;
function check( $label, $got, $want ) {
	global $fail;
	if ( $got === $want ) {
		echo "ok   $label\n";
		return;
	}
	$fail++;
	echo "FAIL $label\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
}

if ( 'on' === $case ) {
	$_SERVER['HTTP_X_PF_R2_TRACE'] = '1';
} elseif ( 'zero' === $case ) {
	$_SERVER['HTTP_X_PF_R2_TRACE'] = '0';
} elseif ( 'empty' === $case ) {
	$_SERVER['HTTP_X_PF_R2_TRACE'] = '';
}
function pf_prop( $name ) {
	$r = new ReflectionProperty( 'R2_Uploads_Stream', $name );
	if ( PHP_VERSION_ID < 80100 ) {
		$r->setAccessible( true );
	}
	return $r;
}
$GLOBALS['sent'] = array();
function post_message_to_js( $json ) {
	$GLOBALS['sent'][] = json_decode( $json, true );
	return '1';
}
$GLOBALS['pf_store'] = array( 'uploads/2026/11/secret-name.png' => 'x' );
function skyphusion_worker_call( $json ) {
	$op    = json_decode( $json, true )['r2'];
	$store = &$GLOBALS['pf_store'];
	if ( 'head' === $op['op'] ) {
		return isset( $store[ $op['key'] ] ) ? json_encode( array( 'ok' => true, 'found' => true, 'size' => 1, 'mtime' => 1 ) ) : json_encode( array( 'ok' => true, 'found' => false ) );
	}
	if ( 'list' === $op['op'] ) {
		return json_encode( array( 'ok' => true, 'keys' => array(), 'prefixes' => array() ) );
	}
	if ( 'put' === $op['op'] ) {
		$store[ $op['key'] ] = base64_decode( $op['body'] );
		return json_encode( array( 'ok' => true ) );
	}
	return json_encode( array( 'ok' => false ) );
}
define( 'R2_UPLOADS', true );
define( 'WP_CONTENT_DIR', '/wordpress/wp-content' );
function add_filter() {}
function add_action() {}
require __DIR__ . '/../php/r2-uploads.php';

function pf_probe_caller_one() {
	R2_Uploads_Stream::call( array( 'op' => 'head', 'key' => 'uploads/2026/11/secret-name-300x200.png' ) );
	R2_Uploads_Stream::call( array( 'op' => 'head', 'key' => 'uploads/2026/11/secret-name-300x200.png' ) ); // cached: no bridge call
	R2_Uploads_Stream::call( array( 'op' => 'list', 'prefix' => 'uploads/2026/11/secret-name-300x200.png/', 'limit' => 1 ) );
	R2_Uploads_Stream::call( array( 'op' => 'list', 'prefix' => 'uploads/2026/11/secret-name-300x200.png/', 'limit' => 1 ) ); // same key twice
	R2_Uploads_Stream::call( array( 'op' => 'put', 'key' => 'uploads/2026/11/secret-name.png', 'body' => base64_encode( 'z' ) ) );
}
pf_probe_caller_one();

if ( 'on' !== $case ) {
	// Off (no header, '0', ''): nothing is RECORDED, not only nothing sent.
	check( "$case: nothing recorded", array( pf_prop( 'trace' )->getValue(), pf_prop( 'trace_total' )->getValue(), pf_prop( 'trace_cached' )->getValue(), pf_prop( 'trace_seen' )->getValue() ), array( array(), 0, 0, array() ) );
	// The flush gate on its own: even with an entry planted, a request without the header sends nothing.
	pf_prop( 'trace' )->setValue( null, array( array( 'o' => 'head', 'k' => 'x', 'ms' => 1, 'd' => 0, 'c' => array() ) ) );
	R2_Uploads_Stream::trace_flush();
	check( "$case: the flush gate alone sends nothing", $GLOBALS['sent'], array() );
	check( "$case: the calls still worked", $GLOBALS['pf_store']['uploads/2026/11/secret-name.png'], 'z' );
	exit( $fail ? 1 : 0 );
}

// key_shape table: file names, dates and dotted names never survive; only a known file type stays.
foreach ( array(
	'uploads/2026/11/photo.JPG'             => 'uploads/<yyyy>/<mm>/<file>.jpg',
	'uploads/2026/11/photo-150x150.webp'    => 'uploads/<yyyy>/<mm>/<file>-<w>x<h>.webp',
	'uploads/2026/11/report.2026'           => 'uploads/<yyyy>/<mm>/<file>',
	'uploads/2026/11/john.smith'            => 'uploads/<yyyy>/<mm>/<file>',
	'uploads/2026/11/john.smith.pdf'        => 'uploads/<yyyy>/<mm>/<file>.pdf',
	'uploads/2026/11/a-300x200.smith'       => 'uploads/<yyyy>/<mm>/<file>',
	'uploads/woocommerce_uploads/inv.zip'   => 'uploads/<dir>/<file>.zip',
	'uploads/2026/11/'                      => 'uploads/<yyyy>/<mm>/',
	'uploads'                               => 'uploads',
	'other/secret/dir.name/'                => '<dir>/<dir>/<dir>/',
) as $in => $want ) {
	check( "key_shape $in", R2_Uploads_Stream::key_shape( $in ), $want );
}

R2_Uploads_Stream::trace_flush();
check( 'one r2Trace message', count( $GLOBALS['sent'] ), 1 );
$t     = $GLOBALS['sent'][0]['r2Trace'] ?? array();
$calls = $t['calls'] ?? array();
check( 'four bridge calls (the cached head is not one)', count( $calls ), 4 );
check( 'the cached head is counted apart', $t['cached'] ?? null, 1 );
check( 'ops in order', array_column( $calls, 'o' ), array( 'head', 'list', 'list', 'put' ) );
check( 'shape of a sub-size file: no name, no date', $calls[0]['k'] ?? null, 'uploads/<yyyy>/<mm>/<file>-<w>x<h>.png' );
check( 'shape of a list prefix keeps the trailing slash', $calls[1]['k'] ?? null, 'uploads/<yyyy>/<mm>/<dir>/' );
check( 'shape of the upload own key', $calls[3]['k'] ?? null, 'uploads/<yyyy>/<mm>/<file>.png' );
check( 'dup: first sight is 0, the repeat is 1', array( $calls[1]['d'], $calls[2]['d'] ), array( 0, 1 ) );
check( 'ms is a number', is_float( $calls[0]['ms'] ) || is_int( $calls[0]['ms'] ), true );
check( 'the caller is a function name, with file and line, not an argument', $calls[0]['c'][0] ?? null, 'pf_probe_caller_one@r2-trace-test.php:' . ( $calls[0]['c'][0] ? (int) substr( strrchr( $calls[0]['c'][0], ':' ), 1 ) : 0 ) );
$all = json_encode( $t );
check( 'no file name or date reaches the payload', str_contains( $all, 'secret' ) || str_contains( $all, '2026' ), false );
check( 'the payload fits a response header', strlen( $all ) < 7800, true );
exit( $fail ? 1 : 0 );
