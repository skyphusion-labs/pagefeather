<?php
/**
 * #780: php/table-status-size.php, with the Worker call stubbed. Site Health's database size sums Data_length and
 * Index_length over SHOW TABLE STATUS; over the SQLite translation every row says 0, so Site Health has no total
 * and /wp-site-health/v1/directory-sizes answers 500. A Durable Object's SQLite gives only the whole database's
 * size (sql.databaseSize; no dbstat, no PRAGMA page_count), so the total goes on the FIRST row's Data_length and
 * every other size stays 0 (per-table sizes are not available, documented).
 * Run: php spikes/b2-wordpress/tests/table-status-size-test.php
 */
require __DIR__ . '/../php/table-status-size.php';
$fails = 0;
function ok( $label, $cond ) { global $fails; echo ( $cond ? 'PASS ' : 'FAIL ' ) . $label . "\n"; if ( ! $cond ) { $fails++; } }
function rows() {
	$out = array();
	foreach ( array( 'wp_posts', 'wp_options', 'wp_users' ) as $n ) {
		$out[] = (object) array( 'Name' => $n, 'Engine' => 'InnoDB', 'Data_length' => '0', 'Index_length' => '0' );
	}
	return $out;
}
$calls = array();
$call  = function ( $json ) use ( &$calls ) { $calls[] = $json; return '{"ok":true,"bytes":1826816}'; };
$r = skyphusion_table_status_size( 'SHOW TABLE STATUS', rows(), $call );
ok( 'one dbSize call', array( '{"dbSize":1}' ) === $calls );
ok( 'the first row carries the whole size', '1826816' === $r[0]->Data_length );
ok( 'every other size is 0', '0' === $r[1]->Data_length && '0' === $r[2]->Data_length && '0' === $r[0]->Index_length );
ok( 'the sum over the rows is the database size (what get_database_size reads)', 1826816 === array_sum( array_map( function ( $x ) { return (int) $x->Data_length + (int) $x->Index_length; }, $r ) ) );
ok( 'the other columns are untouched', 'wp_posts' === $r[0]->Name && 'InnoDB' === $r[0]->Engine );
$calls = array();
$r = skyphusion_table_status_size( '  show table status', rows(), $call );
ok( 'any case: handled', '1826816' === $r[0]->Data_length && 1 === count( $calls ) );
foreach ( array( 'SHOW TABLE STATUS FROM wordpress', 'SHOW TABLE STATUS IN `wordpress`', "SHOW TABLE STATUS FROM wordpress;" ) as $q ) {
	$calls = array();
	$r = skyphusion_table_status_size( $q, rows(), $call );
	ok( "unfiltered ($q): the whole size on the first row", '1826816' === $r[0]->Data_length && 1 === count( $calls ) );
}
// #780 review: a FILTERED query names some tables, and the whole database's size is not theirs. Per-table sizes are
// not available, so a filtered query says 0 (unknown) for every row, and asks the Worker nothing.
foreach ( array( "SHOW TABLE STATUS LIKE 'wp_posts'", '  show table status like "wp_%"', "SHOW TABLE STATUS WHERE Name = 'wp_options'", "SHOW TABLE STATUS FROM wordpress LIKE 'wp_x'" ) as $q ) {
	$calls = array();
	$r = skyphusion_table_status_size( $q, rows(), $call );
	ok( "filtered ($q): every size 0, no call", '0' === $r[0]->Data_length && '0' === $r[1]->Data_length && array() === $calls );
}
$calls = array();
foreach ( array( 'SELECT * FROM wp_posts', 'SHOW TABLES', 'SHOW FULL TABLES', 'SHOW TABLE STATUSX' ) as $q ) {
	$r = skyphusion_table_status_size( $q, rows(), $call );
	ok( "not SHOW TABLE STATUS ($q): unchanged, no call", '0' === $r[0]->Data_length );
}
ok( '  and no call was made for any of them', array() === $calls );
$r = skyphusion_table_status_size( 'SHOW TABLE STATUS', array(), $call );
ok( 'no rows: unchanged', array() === $r );
foreach ( array( '', 'not json', '{"ok":false,"error":"no database in the object"}', '{"ok":true,"bytes":0}', '{"ok":true}' ) as $reply ) {
	$r = skyphusion_table_status_size( 'SHOW TABLE STATUS', rows(), function () use ( $reply ) { return $reply; } );
	ok( 'a reply with no size (' . ( '' === $reply ? 'empty' : $reply ) . '): rows unchanged', '0' === $r[0]->Data_length );
}
echo $fails . " failing\n";
exit( $fails ? 1 : 0 );
