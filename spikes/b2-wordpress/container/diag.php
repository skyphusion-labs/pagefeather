<?php
// Diagnostic for the checkout Container: N statements through worker.internal, timed.
$n  = max( 1, min( 50, (int) ( $_GET['n'] ?? 1 ) ) );
$ch = curl_init( 'http://worker.internal/' );
curl_setopt_array( $ch, array( CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => array( 'Content-Type: application/json' ), CURLOPT_TIMEOUT => 20 ) );
$ms = array();
foreach ( range( 1, $n ) as $i ) {
	$t = microtime( true );
	curl_setopt( $ch, CURLOPT_POSTFIELDS, json_encode( array( 'sql' => 'SELECT option_value FROM wp_options WHERE option_name = ?', 'params' => array( 'siteurl' ) ) ) );
	$r    = curl_exec( $ch );
	$ms[] = round( ( microtime( true ) - $t ) * 1000, 1 );
}
sort( $ms );
header( 'Content-Type: application/json' );
echo json_encode( array( 'n' => $n, 'min' => $ms[0], 'median' => $ms[ intdiv( $n, 2 ) ], 'max' => end( $ms ), 'last_reply' => substr( (string) $r, 0, 120 ), 'curl_error' => curl_error( $ch ) ) );
