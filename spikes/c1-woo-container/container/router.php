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
