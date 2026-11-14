<?php
/*
 * #530 LOCAL TEST ONLY (never in a real build): a PHP in-place write to a file that came from the
 * bundle. ?inplace=write opens inplace-probe-data/target.dat with r+ and overwrites its 64 bytes
 * with B (same length, no truncate, no growth: the MEMFS branch that skips the contents setter).
 * ?inplace=read prints the file. Run write, then read in a NEXT request.
 */
if ( isset( $_GET['inplace'] ) ) {
	$f = __DIR__ . '/inplace-probe-data/target.dat';
	header( 'Content-Type: text/plain' );
	if ( 'write' === $_GET['inplace'] ) {
		$h = fopen( $f, 'r+' );
		$n = fwrite( $h, str_repeat( 'B', 64 ) );
		fclose( $h );
		clearstatcache();
		echo 'wrote ' . $n . ' now ' . file_get_contents( $f ) . "\n";
	} else {
		echo 'read ' . file_get_contents( $f ) . "\n";
	}
	exit;
}
