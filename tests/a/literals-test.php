<?php
/**
 * Tests of spikes/b2-wordpress/php/hyperdrive-literals.php (issue #79): SQL for
 * approach A's Worker bridge. Pure PHP: php tests/a/literals-test.php
 * Exits 1 on any failure. The real round trip on MySQL is in docs/approach-a.md.
 */
require __DIR__ . '/../../spikes/b2-wordpress/php/hyperdrive-literals.php';

$fails = 0;
$n     = 0;
function t( $name, $ok, $got = null ) {
	global $fails, $n;
	++$n;
	if ( ! $ok ) {
		++$fails;
	}
	echo ( $ok ? 'ok   ' : 'FAIL ' ) . $name . ( $ok ? '' : '  got: ' . var_export( $got, true ) ) . "\n";
}
$f = 'skyphusion_hd_sql_for_bridge';
$e = 'skyphusion_mysql_escape';

// Valid UTF-8 is never changed, byte for byte.
foreach ( array( "SELECT 1", "INSERT INTO t VALUES ('caf\xc3\xa9', 'it\\'s', \"q\")", "SELECT '' , ''''", '' ) as $sql ) {
	t( 'UTF-8 unchanged: ' . substr( $sql, 0, 30 ), $f( $sql ) === $sql, $f( $sql ) );
}
// A binary literal becomes a hex literal; the rest stays.
t( 'raw bytes', "INSERT INTO t (b) VALUES (X'e9ff80')" === $f( "INSERT INTO t (b) VALUES ('\xe9\xff\x80')" ), $f( "INSERT INTO t (b) VALUES ('\xe9\xff\x80')" ) );
t( 'escaped NUL and bytes', "SELECT X'007f80'" === $f( "SELECT '" . $e( "\x00\x7f\x80" ) . "'" ), $f( "SELECT '" . $e( "\x00\x7f\x80" ) . "'" ) );
t( 'an escaped quote in the value', "SELECT X'6974277366ff'" === $f( "SELECT 'it\\'sf\xff'" ), $f( "SELECT 'it\\'sf\xff'" ) );
t( 'a doubled quote in the value', "SELECT X'612762ff'" === $f( "SELECT 'a''b\xff'" ), $f( "SELECT 'a''b\xff'" ) );
t( 'backslash percent keeps its backslash (LIKE)', "SELECT X'785c25ff'" === $f( "SELECT 'x\\%\xff'" ), $f( "SELECT 'x\\%\xff'" ) );
t( 'a double-quoted literal', "SELECT X'ff80'" === $f( "SELECT \"\xff\x80\"" ), $f( "SELECT \"\xff\x80\"" ) );
t( 'only the binary literal changes', "UPDATE t SET a = 'caf\xc3\xa9', b = X'ff' WHERE c = 'x'" === $f( "UPDATE t SET a = 'caf\xc3\xa9', b = '\xff' WHERE c = 'x'" ), $f( "UPDATE t SET a = 'caf\xc3\xa9', b = '\xff' WHERE c = 'x'" ) );
t( 'a backticked name with a quote is kept', "SELECT `we'ird` = X'ff'" === $f( "SELECT `we'ird` = '\xff'" ), $f( "SELECT `we'ird` = '\xff'" ) );
t( 'a doubled backtick in a name', "SELECT `a``'b` = X'ff'" === $f( "SELECT `a``'b` = '\xff'" ), $f( "SELECT `a``'b` = '\xff'" ) );
t( 'a -- comment with an apostrophe is kept', "-- don't\nSELECT X'ff'" === $f( "-- don't\nSELECT '\xff'" ), $f( "-- don't\nSELECT '\xff'" ) );
t( 'a # comment with an apostrophe is kept', "# it's\nSELECT X'ff'" === $f( "# it's\nSELECT '\xff'" ), $f( "# it's\nSELECT '\xff'" ) );
t( 'a /* */ comment with an apostrophe is kept', "SELECT /* it's */ X'ff'" === $f( "SELECT /* it's */ '\xff'" ), $f( "SELECT /* it's */ '\xff'" ) );
t( 'a charset introducer gets a space', "SELECT _binary X'ff'" === $f( "SELECT _binary'\xff'" ), $f( "SELECT _binary'\xff'" ) );
t( 'bytes outside any literal: null', null === $f( "SELECT \xff" ), $f( "SELECT \xff" ) );
t( 'an unterminated binary literal: null', null === $f( "SELECT '\xff" ), $f( "SELECT '\xff" ) );
t( 'minus minus without a space is not a comment', "SELECT 1--1, X'ff'" === $f( "SELECT 1--1, '\xff'" ), $f( "SELECT 1--1, '\xff'" ) );

// Property: any value, escaped as wpdb escapes it, comes back as its exact bytes.
mt_srand( 79 );
$bad = 0;
for ( $k = 0; $k < 2000; $k++ ) {
	$len = mt_rand( 0, 40 );
	$v   = '';
	for ( $i = 0; $i < $len; $i++ ) {
		$v .= chr( mt_rand( 0, 255 ) );
	}
	$out = $f( "INSERT INTO t (b) VALUES ('" . $e( $v ) . "')" );
	if ( null === $out || ! preg_match( '//u', $out ) ) {
		++$bad;
		continue;
	}
	if ( preg_match( "/^INSERT INTO t \\(b\\) VALUES \\(X'([0-9a-f]*)'\\)$/", $out, $m ) ) {
		$back = hex2bin( $m[1] );
	} elseif ( preg_match( '//u', $v ) ) {
		// Valid UTF-8 values go unchanged (MySQL unescapes them itself).
		$back = ( $out === "INSERT INTO t (b) VALUES ('" . $e( $v ) . "')" ) ? $v : null;
	} else {
		$back = null;
	}
	if ( $back !== $v ) {
		++$bad;
	}
}
t( '2000 random values: every one comes back as its bytes', 0 === $bad, $bad );

echo "tests $n, FAILS $fails\n";
exit( $fails ? 1 : 0 );
