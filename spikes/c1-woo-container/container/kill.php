<?php
// Spike only: stop this container from inside, for durability tests.
// sig=TERM: Litestream (PID 1) shuts down cleanly. sig=KILL: like a crash.
// Needs the x-spike-token header (SPIKE_TOKEN from the Worker).
$token = getenv( 'SPIKE_TOKEN' );
if ( ! $token || ! hash_equals( $token, (string) ( $_SERVER['HTTP_X_SPIKE_TOKEN'] ?? '' ) ) ) {
	http_response_code( 403 );
	exit( 'forbidden' );
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
