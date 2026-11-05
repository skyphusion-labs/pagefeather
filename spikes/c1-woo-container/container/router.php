<?php
// Idle watchdog (entrypoint.sh): every request marks the time, except health
// checks (/ping) and the test boot id, which would keep the container awake.
if ( ! in_array( parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH ), array( '/ping', '/_boot.txt' ), true ) ) {
	@touch( '/tmp/last-request' );
}
// Router for PHP's built-in server: static files as they are, PHP files run,
// everything else goes to WordPress (index.php).
$path = parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );
$file = realpath( __DIR__ . $path );
// A directory with an index.php (/wp-admin/) runs it, as Apache and nginx do.
// Without this, /wp-admin/ went to WordPress and showed the home page
// (found 2026-11-05 by tests/plugins/plugins.py).
if ( $file && 0 === strpos( $file, __DIR__ ) && is_dir( $file ) && is_file( $file . '/index.php' ) ) {
	if ( '/' !== substr( $path, -1 ) ) {
		header( 'Location: ' . $path . '/' . ( empty( $_SERVER['QUERY_STRING'] ) ? '' : '?' . $_SERVER['QUERY_STRING'] ), true, 301 );
		return true;
	}
	$path .= 'index.php';
	$file .= '/index.php';
}
if ( $file && 0 === strpos( $file, __DIR__ ) && is_file( $file ) ) {
	if ( '.php' !== substr( $file, -4 ) ) {
		return false;
	}
	$_SERVER['SCRIPT_NAME']     = $path;
	$_SERVER['SCRIPT_FILENAME'] = $file;
	chdir( dirname( $file ) );
	require $file;
	return true;
}
$_SERVER['SCRIPT_NAME']     = '/index.php';
$_SERVER['SCRIPT_FILENAME'] = __DIR__ . '/index.php';
require __DIR__ . '/index.php';
