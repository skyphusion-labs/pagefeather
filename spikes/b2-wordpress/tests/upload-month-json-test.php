<?php
// php tests/upload-month-json-test.php
// Issue #594. An image upload into a month directory that does not exist yet
// prints PHP chmod warnings before the REST JSON, so the body is not JSON.
// This is that upload against php/r2-uploads.php: wp_mkdir_p from WordPress
// 7.1.4 (wp-includes/functions.php, the chmod at line 2107), then the JSON a
// REST media response would send. The process directory is mode 0777 with
// umask 022, the php-wasm MEMFS root. display_errors is on, as in local dev.
//
// seeded: the uploads prefix already holds an object (the control; already quiet).
// empty: nothing under uploads/. The month directory does not exist. This is
// the first upload on a site, and the case that answered 200 with a warning.

$case = getenv( 'PF_CASE' );
if ( false === $case || '' === $case ) {
	$fail = 0;
	foreach ( array( 'seeded', 'empty' ) as $c ) {
		echo "== case: $c ==\n";
		$cmd = 'PF_CASE=' . $c . ' ' . escapeshellarg( PHP_BINARY ) . ' ' . escapeshellarg( __FILE__ );
		passthru( $cmd, $code );
		if ( 0 !== $code ) {
			$fail++;
		}
	}
	echo $fail ? "\n$fail CASE(S) FAILED\n" : "\nALL CASES PASS\n";
	exit( $fail ? 1 : 0 );
}

ini_set( 'display_errors', '1' );
ini_set( 'html_errors', '0' );
error_reporting( E_ALL );

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

// The wasm filesystem root is mode 0777. wp_mkdir_p stats that directory when
// no stream parent exists, and 0777 is outside umask 022, so it calls chmod.
$root = sys_get_temp_dir() . '/pf594-' . getmypid();
mkdir( $root, 0777 );
chmod( $root, 0777 );
$back = getcwd();
chdir( $root );
umask( 0022 );
register_shutdown_function(
	function () use ( $back, $root ) {
		chdir( $back );
		@rmdir( $root );
	}
);
check( 'process directory is mode 0777 (wasm root)', fileperms( '.' ) & 07777, 0777 );

// ---- In-memory R2, the same replies the Worker sends. ----
$GLOBALS['pf_store'] = array();
function skyphusion_worker_call( $json ) {
	$op    = json_decode( $json, true )['r2'];
	$store = &$GLOBALS['pf_store'];
	if ( 'head' === $op['op'] ) {
		if ( isset( $store[ $op['key'] ] ) ) {
			return json_encode( array( 'ok' => true, 'found' => true, 'size' => strlen( $store[ $op['key'] ] ), 'mtime' => 1 ) );
		}
		return json_encode( array( 'ok' => true, 'found' => false ) );
	}
	if ( 'list' === $op['op'] ) {
		$keys = array();
		foreach ( array_keys( $store ) as $k ) {
			if ( str_starts_with( $k, $op['prefix'] ) ) {
				$keys[] = $k;
			}
		}
		$limit = isset( $op['limit'] ) ? (int) $op['limit'] : 1000;
		return json_encode( array( 'ok' => true, 'keys' => array_slice( $keys, 0, $limit ), 'prefixes' => array() ) );
	}
	if ( 'put' === $op['op'] ) {
		$store[ $op['key'] ] = base64_decode( $op['body'] );
		return json_encode( array( 'ok' => true ) );
	}
	if ( 'get' === $op['op'] ) {
		if ( ! isset( $store[ $op['key'] ] ) ) {
			return json_encode( array( 'ok' => true, 'found' => false ) );
		}
		return json_encode( array( 'ok' => true, 'found' => true, 'body' => base64_encode( $store[ $op['key'] ] ), 'size' => strlen( $store[ $op['key'] ] ), 'mtime' => 1 ) );
	}
	return json_encode( array( 'ok' => false, 'error' => 'unknown r2 op' ) );
}

define( 'R2_UPLOADS', true );
define( 'WP_CONTENT_DIR', '/wordpress/wp-content' );
$GLOBALS['hooks'] = array();
function add_filter( $hook, $cb, $prio = 10, $args = 1 ) {
	$GLOBALS['hooks'][ $hook ][] = $cb;
}
function add_action( $hook, $cb, $prio = 10, $args = 1 ) {
}
function apply_filters( $hook, $value ) {
	foreach ( $GLOBALS['hooks'][ $hook ] ?? array() as $cb ) {
		$value = $cb( $value );
	}
	return $value;
}
function wp_die( $msg ) {
	fwrite( STDERR, "wp_die: $msg\n" );
	exit( 1 );
}
require __DIR__ . '/../php/r2-uploads.php';

// WordPress 7.1.4 wp_is_stream and wp_mkdir_p (functions.php). The chmod at
// the line the warning names is not suppressed: a failure is printed.
function wp_is_stream( $path ) {
	$scheme_separator = strpos( $path, '://' );
	if ( false === $scheme_separator ) {
		return false;
	}
	$stream = substr( $path, 0, $scheme_separator );
	return in_array( $stream, stream_get_wrappers(), true );
}
function wp_mkdir_p( $target ) {
	$wrapper = null;
	if ( wp_is_stream( $target ) ) {
		list( $wrapper, $target ) = explode( '://', $target, 2 );
	}
	$target = str_replace( '//', '/', $target );
	if ( null !== $wrapper ) {
		$target = $wrapper . '://' . $target;
	}
	$target = rtrim( $target, '/' );
	if ( empty( $target ) ) {
		$target = '/';
	}
	if ( file_exists( $target ) ) {
		return @is_dir( $target );
	}
	if ( str_contains( $target, '../' ) || str_contains( $target, '..' . DIRECTORY_SEPARATOR ) ) {
		return false;
	}
	$target_parent = dirname( $target );
	while ( '.' !== $target_parent && ! is_dir( $target_parent ) && dirname( $target_parent ) !== $target_parent ) {
		$target_parent = dirname( $target_parent );
	}
	$stat = @stat( $target_parent );
	if ( $stat ) {
		$dir_perms = $stat['mode'] & 0007777;
	} else {
		$dir_perms = 0777;
	}
	if ( @mkdir( $target, $dir_perms, true ) ) {
		if ( ( $dir_perms & ~umask() ) !== $dir_perms ) {
			$folder_parts = explode( '/', substr( $target, strlen( $target_parent ) + 1 ) );
			for ( $i = 1, $c = count( $folder_parts ); $i <= $c; $i++ ) {
				chmod( $target_parent . '/' . implode( '/', array_slice( $folder_parts, 0, $i ) ), $dir_perms );
			}
		}
		return true;
	}
	return false;
}

// 1x1 PNG.
$png  = hex2bin( '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63f8cfc00000000300010005fe02fe0000000049454e44ae426082' );
$year = 'seeded' === $case ? '2098' : '2099';
$mon  = 'seeded' === $case ? '03' : '08';
$rel  = $year . '/' . $mon;
$name = 'a.png';
if ( 'seeded' === $case ) {
	$GLOBALS['pf_store']['uploads/2020/01/old.png'] = 'old';
}

$month = 'r2://uploads/' . $rel;
check( 'the uploads root is a directory before any object', is_dir( 'r2://uploads' ), true );
check( 'the month directory does not exist yet', is_dir( $month ), false );
$prefix = 'uploads/' . $rel . '/';
$had    = false;
foreach ( array_keys( $GLOBALS['pf_store'] ) as $k ) {
	if ( str_starts_with( $k, $prefix ) ) {
		$had = true;
	}
}
check( 'the month prefix has no objects', $had, false );

$dirs = apply_filters(
	'upload_dir',
	array(
		'path'    => WP_CONTENT_DIR . '/uploads/' . $rel,
		'url'     => 'http://localhost/wp-content/uploads/' . $rel,
		'subdir'  => '/' . $rel,
		'basedir' => WP_CONTENT_DIR . '/uploads',
		'baseurl' => 'http://localhost/wp-content/uploads',
		'error'   => false,
	)
);
check( 'upload_dir points the month at r2', $dirs['path'], $month );

// The REST body is whatever was printed, then the JSON. A chmod warning
// printed first makes the whole body invalid JSON. Local dev does this
// with WP_DEBUG_DISPLAY (php/wp-config.php).
ob_start();
$made = wp_mkdir_p( $dirs['path'] );
$n    = file_put_contents( $dirs['path'] . '/' . $name, $png );
echo json_encode(
	array(
		'id'            => 7,
		'mime_type'     => 'image/png',
		'source_url'    => $dirs['url'] . '/' . $name,
		'media_details' => array( 'file' => $rel . '/' . $name ),
	)
);
$raw = ob_get_clean();

$key = 'uploads/' . $rel . '/' . $name;
check( 'mkdir of the new month succeeded', $made, true );
check( 'the image was written', $n, strlen( $png ) );
check( 'the object is the png', isset( $GLOBALS['pf_store'][ $key ] ) ? $GLOBALS['pf_store'][ $key ] : null, $png );

$parsed = json_decode( $raw, true );
check( 'the response body parses as JSON', is_array( $parsed ), true );
check(
	'the JSON is the media object',
	is_array( $parsed ) ? array( $parsed['id'] ?? null, $parsed['mime_type'] ?? null, $parsed['media_details']['file'] ?? null ) : null,
	array( 7, 'image/png', $rel . '/' . $name )
);
check( 'the response body has no warning text', str_contains( $raw, 'Warning' ) || str_contains( $raw, 'chmod()' ), false );
if ( ! is_array( $parsed ) || str_contains( $raw, 'Warning' ) ) {
	echo "  body starts: " . substr( $raw, 0, 300 ) . "\n";
}

exit( $fail ? 1 : 0 );
