<?php
/**
 * TEST ONLY (issue #29): the surface of spikes/b2-wordpress/php/hyperdrive-mysqli.php
 * in our php-wasm, which has no mysqli extension. Never shipped: tests/a/mysqli-surface.sh
 * copies it and hyperdrive-mysqli.php into a built tree.
 *
 * The bridge is a STUB here (skyphusion_hd_run below): this proves the PHP
 * surface (classes, functions, fetch modes, errors, report modes) in the real
 * engine, NOT the bridge or MySQL. That needs approach A on a real database.
 *
 * GET /?mysqlisurface=1 answers JSON lines: {"ok": bool, "check": name, "got": ...}.
 */
if ( ! isset( $_GET['mysqlisurface'] ) ) {
	return;
}
$skyphusion_t_sent = array();
function skyphusion_hd_run( $sql ) {
	global $skyphusion_t_sent;
	$skyphusion_t_sent[] = $sql;
	if ( 'SELECT VERSION()' === $sql ) {
		return array( 'ok' => true, 'columns' => array( 'VERSION()' ), 'rows' => array( array( '11.4.4-MariaDB' ) ) );
	}
	if ( 0 === strpos( $sql, 'SELECT a, b' ) ) {
		return array( 'ok' => true, 'columns' => array( 'a', 'b' ), 'rows' => array( array( '1', null ), array( '2', array( '$b' => base64_encode( "\xff\x00\xfe" ) ) ) ) );
	}
	if ( 0 === strpos( $sql, 'UPDATE' ) ) {
		return array( 'ok' => true, 'affected' => 3, 'insert_id' => 0 );
	}
	if ( 0 === strpos( $sql, 'INSERT' ) ) {
		return array( 'ok' => true, 'affected' => 1, 'insert_id' => 7 );
	}
	if ( 0 === strpos( $sql, 'SELECT * FROM missing' ) ) {
		return array( 'ok' => false, 'error' => "Table 'wordpress.missing' doesn't exist", 'errno' => 1146 );
	}
	return array( 'ok' => false, 'error' => 'stub: unexpected SQL ' . $sql, 'errno' => 9999 );
}
if ( ! function_exists( 'skyphusion_mysql_escape' ) ) {
	function skyphusion_mysql_escape( $s ) {
		return 'ESC[' . $s . ']'; // Routing only: the real table is in hyperdrive-db.php.
	}
}
require_once WP_CONTENT_DIR . '/hyperdrive-mysqli.php';

header( 'content-type: application/x-ndjson' );
function skyphusion_t( $check, $ok, $got = null ) {
	echo json_encode( array( 'ok' => (bool) $ok, 'check' => $check, 'got' => $got ), JSON_INVALID_UTF8_SUBSTITUTE ) . "\n";
}

skyphusion_t( 'the userland mysqli is loaded (no extension in this engine)', defined( 'SKYPHUSION_USERLAND_MYSQLI' ) && ! extension_loaded( 'mysqli' ) && class_exists( 'mysqli', false ) && class_exists( 'mysqli_result', false ) );
$m = new mysqli();
skyphusion_t( '$wpdb->dbh-shaped object is a mysqli', $m instanceof mysqli );

// Exactly the calls of All-in-One WP Migration (Ai1wm_Database_Mysqli), with reporting off as wpdb sets it.
mysqli_report( MYSQLI_REPORT_OFF );
$ok = mysqli_real_query( $m, 'SELECT a, b FROM t' );
$r  = mysqli_store_result( $m );
skyphusion_t( 'real_query then store_result gives a mysqli_result', $ok && $r instanceof mysqli_result, get_class( $r ) );
skyphusion_t( 'num_rows', 2 === mysqli_num_rows( $r ), mysqli_num_rows( $r ) );
$a = mysqli_fetch_assoc( $r );
skyphusion_t( 'fetch_assoc: strings and null, as mysqli', array( 'a' => '1', 'b' => null ) === $a, $a );
$row = mysqli_fetch_row( $r );
skyphusion_t( 'fetch_row: a binary value comes back as its bytes', array( '2', "\xff\x00\xfe" ) === $row, bin2hex( (string) ( $row[1] ?? '' ) ) );
skyphusion_t( 'past the last row: null', null === mysqli_fetch_assoc( $r ) );
mysqli_free_result( $r );
skyphusion_t( 'free_result empties the result', 0 === mysqli_num_rows( $r ) );
skyphusion_t( 'real_escape_string goes to the shared escape', 'ESC[x]' === mysqli_real_escape_string( $m, 'x' ) );
skyphusion_t( 'errno and error after success', 0 === mysqli_errno( $m ) && '' === mysqli_error( $m ) );
$v1 = mysqli_get_server_info( $m );
$v2 = mysqli_get_server_info( $m );
skyphusion_t( 'get_server_info, asked once (cached)', '11.4.4-MariaDB' === $v1 && $v1 === $v2 && 1 === count( array_keys( $skyphusion_t_sent, 'SELECT VERSION()', true ) ), $v1 );
skyphusion_t( 'server_version from the info', 110404 === $m->server_version, $m->server_version );

// A statement with no result set.
$ok = mysqli_real_query( $m, 'UPDATE t SET a = 1' );
skyphusion_t( 'a write: real_query true, store_result false, errno 0', $ok && false === mysqli_store_result( $m ) && 0 === mysqli_errno( $m ) );
skyphusion_t( 'affected_rows', 3 === mysqli_affected_rows( $m ), mysqli_affected_rows( $m ) );
skyphusion_t( 'query() of a write is true', true === mysqli_query( $m, 'INSERT INTO t VALUES (1)' ) && 7 === mysqli_insert_id( $m ), mysqli_insert_id( $m ) );

// Errors, reporting off: false, with errno and error.
$ok = mysqli_real_query( $m, 'SELECT * FROM missing' );
skyphusion_t( 'an error, reporting off: false', false === $ok );
skyphusion_t( 'errno and error of the server', 1146 === mysqli_errno( $m ) && false !== strpos( mysqli_error( $m ), 'missing' ), array( mysqli_errno( $m ), mysqli_error( $m ) ) );
skyphusion_t( 'store_result after an error: false', false === mysqli_store_result( $m ) );
skyphusion_t( 'prepare: false with an error (not supported)', false === mysqli_prepare( $m, 'SELECT ?' ) && false !== strpos( mysqli_error( $m ), 'prepared' ) );

// Errors, PHP 8.1 default reporting: an exception.
mysqli_report( MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT );
$code = null;
try {
	mysqli_query( $m, 'SELECT * FROM missing' );
} catch ( mysqli_sql_exception $e ) {
	$code = $e->getCode();
}
skyphusion_t( 'an error, strict reporting: mysqli_sql_exception with the errno', 1146 === $code, $code );
mysqli_report( MYSQLI_REPORT_OFF );

// Fetch modes, seek, fields.
$r = mysqli_query( $m, 'SELECT a, b FROM t' );
$both = mysqli_fetch_array( $r );
skyphusion_t( 'fetch_array BOTH: numeric and named', '1' === $both[0] && '1' === $both['a'] && array_key_exists( 1, $both ) && array_key_exists( 'b', $both ) );
$o = mysqli_fetch_object( $r );
skyphusion_t( 'fetch_object', $o instanceof stdClass && '2' === $o->a );
skyphusion_t( 'data_seek(0) and fetch_all NUM', mysqli_data_seek( $r, 0 ) && 2 === count( mysqli_fetch_all( $r ) ) );
$names = array_map( function ( $f ) { return $f->name; }, mysqli_fetch_fields( $r ) );
skyphusion_t( 'fetch_fields names; num_fields', array( 'a', 'b' ) === $names && 2 === mysqli_num_fields( $r ), $names );
skyphusion_t( 'data_seek past the end: false', false === mysqli_data_seek( $r, 5 ) );

// wpdb::flush() and bail() paths on a mysqli dbh.
skyphusion_t( 'more_results false, next_result false (wpdb::flush)', false === mysqli_more_results( $m ) && false === mysqli_next_result( $m ) );
skyphusion_t( 'character_set_name utf8mb4, set_charset true', 'utf8mb4' === mysqli_character_set_name( $m ) && true === mysqli_set_charset( $m, 'utf8mb4' ) );
skyphusion_t( 'select_db of another database: false', ! defined( 'DB_NAME' ) || false === mysqli_select_db( $m, DB_NAME . '_other' ) );
skyphusion_t( 'ping, close: true', true === mysqli_ping( $m ) && true === mysqli_close( $m ) );
skyphusion_t( 'every statement reached the bridge, none other', array( 'SELECT a, b FROM t', 'SELECT VERSION()', 'UPDATE t SET a = 1', 'INSERT INTO t VALUES (1)', 'SELECT * FROM missing', 'SELECT * FROM missing', 'SELECT a, b FROM t' ) === $skyphusion_t_sent, $skyphusion_t_sent );
exit;
