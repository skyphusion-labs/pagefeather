<?php
// php tests/dialect-test.php  (after ./build.sh, which fetches the driver)
require __DIR__ . '/../build/cache/sqlite-database-integration/packages/mysql-on-sqlite/src/sqlite/class-wp-sqlite-pdo-user-defined-functions.php';
require __DIR__ . '/../php/d1-dialect.php';

$fail = 0;
function check( $label, $got, $want ) {
	global $fail;
	if ( $got === $want ) { echo "ok   $label\n"; return; }
	$fail++; echo "FAIL $label\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
}
$none = function () { throw new Exception( 'no D1 call expected' ); };

list( $s ) = D1_Dialect::rewrite( "SELECT DISTINCT `YEAR` ( `post_date` ) AS `year` , `MONTH` ( `post_date` ) AS `month` FROM `wp_posts`", array(), $none );
check( 'YEAR and MONTH become substr', $s, "SELECT DISTINCT CAST(substr(( `post_date` ), 1, 4) AS INTEGER) AS `year` , CAST(substr(( `post_date` ), 6, 2) AS INTEGER) AS `month` FROM `wp_posts`" );

list( $s, $p ) = D1_Dialect::rewrite( "SELECT md5(?) AS h, ? AS x", array( 'abc', 7 ), $none );
check( 'md5 of a bound parameter is inlined', array( $s, $p ), array( "SELECT '900150983cd24fb0d6963f7d28e17f72' AS h, ? AS x", array( 7 ) ) );

list( $s ) = D1_Dialect::rewrite( "SELECT FIELD(`ID`, 3, 1) FROM t", array(), $none );
check( 'FIELD becomes CASE', $s, "SELECT CASE WHEN (`ID`) IS NULL THEN 0 WHEN lower((`ID`)) = lower(( 3)) THEN 1 WHEN lower((`ID`)) = lower(( 1)) THEN 2 ELSE 0 END FROM t" );

list( $s ) = D1_Dialect::rewrite( "SELECT year(now())", array(), $none );
check( 'nested calls', $s, "SELECT CAST(substr((datetime('now')), 1, 4) AS INTEGER)" );

list( $s ) = D1_Dialect::rewrite( "SELECT `t`.`year` FROM t", array(), $none );
check( 'a column named year is left alone', $s, "SELECT `t`.`year` FROM t" );

$seen = array();
$run  = function ( $sql, $params ) use ( &$seen ) {
	$seen[] = $sql;
	return array( 'columns' => array( 'rowid', 'option_name' ), 'rows' => array( array( 1, 'rss_' . str_repeat( 'a', 32 ) ), array( 2, 'siteurl' ), array( 3, 'rss_' . str_repeat( 'b', 32 ) . '_ts' ) ) );
};
list( $s ) = D1_Dialect::rewrite( "DELETE FROM `wp_options` WHERE `option_name` REGEXP '^rss_[0-9a-f]{32}(_ts)?$'", array(), $run );
check( 'REGEXP reads the column once', $seen, array( 'SELECT rowid, `option_name` FROM `wp_options`' ) );
check( 'REGEXP becomes a rowid filter', $s, "DELETE FROM `wp_options` WHERE rowid IN (1,3)" );

list( $s ) = D1_Dialect::rewrite( "SELECT 1 FROM `t` WHERE `c` NOT REGEXP 'zzz'", array(), function () { return array( 'columns' => array(), 'rows' => array() ); } );
check( 'NOT REGEXP with no match keeps every row', $s, "SELECT 1 FROM `t` WHERE 1" );

try {
	D1_Dialect::rewrite( "SELECT md5(`c`) FROM t", array(), $none );
	check( 'md5 of a column is refused', 'no exception', 'exception' );
} catch ( D1_Dialect_Unsupported $e ) {
	check( 'md5 of a column is refused', $e->getMessage(), 'md5() with a non-constant argument' );
}

list( $s ) = D1_Dialect::rewrite( "SELECT 'year(x)' AS a", array(), $none );
check( 'text inside a string is not rewritten', $s, "SELECT 'year(x)' AS a" );

echo $fail ? "$fail failed\n" : "all passed\n";
exit( $fail ? 1 : 0 );
