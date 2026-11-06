<?php
// Spike only: stop this container from inside, for durability tests.
// sig=TERM: Litestream (PID 1) shuts down cleanly. sig=KILL: like a crash.
// Needs the x-spike-token header (SPIKE_TOKEN from the Worker).
$token = getenv( 'SPIKE_TOKEN' );
if ( ! $token || ! hash_equals( $token, (string) ( $_SERVER['HTTP_X_SPIKE_TOKEN'] ?? '' ) ) ) {
	http_response_code( 403 );
	exit( 'forbidden' );
}
// sig=STOPPHP (issue #93): SIGSTOP to every PHP-FPM child, this one last.
// No child is free, so no PHP request is answered: a stuck PHP, for testing the
// container fetch timeout. Only a new container ends it. The master runs as
// root and is not stopped (a child cannot signal it); nginx still answers
// static files (issue #99), so c1_check probes /_fpm-ping as well.
if ( ( $_GET['sig'] ?? '' ) === 'STOPPHP' ) {
	$me   = getmypid();
	$pids = array();
	foreach ( glob( '/proc/[0-9]*/comm' ) as $f ) {
		if ( 'php-fpm' === trim( (string) @file_get_contents( $f ) ) ) {
			$pids[] = (int) basename( dirname( $f ) );
		}
	}
	$master = (int) @file_get_contents( '/run/php-fpm.pid' );
	$pids   = array_values( array_diff( $pids, array( $master ) ) );
	echo 'SIGSTOP to PHP-FPM children ' . implode( ' ', $pids ) . "\n";
	flush();
	foreach ( $pids as $p ) {
		if ( $p !== $me ) {
			posix_kill( $p, 19 );
		}
	}
	posix_kill( $me, 19 );
	exit;
}
// TERM goes to PID 1 (the entrypoint shell), which forwards it to Litestream.
// KILL goes to Litestream itself: no final sync, the container exits.
$kill = ( $_GET['sig'] ?? 'TERM' ) === 'KILL';
$sig  = $kill ? 9 : 15;
$pid  = $kill ? (int) @file_get_contents( '/run/litestream.pid' ) : 1;
echo "signal $sig to PID $pid\n";
if ( function_exists( 'fastcgi_finish_request' ) ) {
	fastcgi_finish_request();
}
flush();
posix_kill( $pid ?: 1, $sig );
