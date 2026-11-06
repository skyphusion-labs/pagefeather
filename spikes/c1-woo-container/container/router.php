<?php
// Idle watchdog (entrypoint.sh): every request marks the time, except health
// checks (/ping), the test boot id, and the container's own queue runner
// (wp-cron.php from 127.0.0.1), which would keep the container awake.
$c1_path = parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );
$c1_self = '/wp-cron.php' === $c1_path && '127.0.0.1' === ( $_SERVER['REMOTE_ADDR'] ?? '' );
if ( ! $c1_self && ! in_array( $c1_path, array( '/ping', '/_boot.txt' ), true ) ) {
	@touch( '/tmp/last-request' );
}
// Request log for the concurrency work (container/stats.php, what=req): start
// time, wall seconds, CPU seconds of this worker, peak MiB, status, method,
// path. Overlap of start and end gives the requests in flight at any time.
// The stats request itself is not logged.
if ( '/_stats.php' !== parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH ) ) {
	// The PHP worker that answered: tests/cache_check.py uses it to show that
	// reads came from more than one worker.
	header( 'x-c1-pid: ' . getmypid() );
	$c1_t0  = microtime( true );
	$c1_ru0 = getrusage();
	// Registered first, so it runs before WordPress's own shutdown functions.
	// It registers the log line again from inside the shutdown, which puts it
	// last: the time then includes WordPress's shutdown work.
	register_shutdown_function(
		function () use ( $c1_t0, $c1_ru0 ) {
			register_shutdown_function( 'c1_log_request', $c1_t0, $c1_ru0 );
		}
	);
}
function c1_log_request( $c1_t0, $c1_ru0 ) {
	$ru  = getrusage();
	$cpu = ( $ru['ru_utime.tv_sec'] - $c1_ru0['ru_utime.tv_sec'] ) + ( $ru['ru_stime.tv_sec'] - $c1_ru0['ru_stime.tv_sec'] )
		+ ( ( $ru['ru_utime.tv_usec'] - $c1_ru0['ru_utime.tv_usec'] ) + ( $ru['ru_stime.tv_usec'] - $c1_ru0['ru_stime.tv_usec'] ) ) / 1e6;
	@file_put_contents(
		'/tmp/c1-req.log',
		sprintf( "%.3f %.3f %.3f %.0f %d %s %s\n", $c1_t0, microtime( true ) - $c1_t0, $cpu, memory_get_peak_usage() / 1048576, http_response_code(), $_SERVER['REQUEST_METHOD'], strtok( $_SERVER['REQUEST_URI'], ' ' ) ),
		FILE_APPEND | LOCK_EX
	);
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
