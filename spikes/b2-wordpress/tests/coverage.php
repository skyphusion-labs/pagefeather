<?php
// Line coverage of php/d1-dialect.php under tests/dialect-test.php. Needs the pcov extension.
// php -d pcov.enabled=1 tests/coverage.php [min-percent]
$target = realpath( __DIR__ . '/../php/d1-dialect.php' );
$min    = isset( $argv[1] ) ? (float) $argv[1] : 0.0;
if ( ! function_exists( 'pcov\start' ) ) {
	fwrite( STDERR, "pcov is not loaded\n" );
	exit( 2 );
}
\pcov\start();
register_shutdown_function( function () use ( $target, $min ) {
	\pcov\stop();
	$data = \pcov\collect( \pcov\inclusive, array( $target ) );
	$lines = isset( $data[ $target ] ) ? $data[ $target ] : array();
	$hit = count( array_filter( $lines, function ( $v ) { return $v > 0; } ) );
	$all = count( $lines );
	$pct = $all ? 100 * $hit / $all : 0;
	printf( "coverage php/d1-dialect.php: %d of %d lines, %.1f%%\n", $hit, $all, $pct );
	if ( $all === 0 || $pct < $min ) {
		printf( "coverage is below the minimum %.1f%%\n", $min );
		exit( 1 );
	}
} );
require __DIR__ . '/dialect-test.php';
