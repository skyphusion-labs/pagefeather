<?php
// Spike C1 (issue #99): runs before every PHP request (auto_prepend_file in
// php-fpm-c1.conf). nginx does the routing and the idle watchdog mark
// (nginx.conf); this file keeps the measurement that container/router.php did
// under php -S.
//
// Request log for the concurrency work (container/stats.php, what=req): start
// time, wall seconds, CPU seconds of this child, peak MiB, status, method,
// path. Overlap of start and end gives the requests in flight at any time.
// The stats request itself is not logged.
if ( '/_stats.php' !== parse_url( $_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH ) ) {
	// The PHP child that answered: tests/cache_check.py uses it to show that
	// reads came from more than one child.
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
