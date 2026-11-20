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

$long = str_repeat( 'a', 60 );
list( $s ) = D1_Dialect::rewrite( "SELECT 1 FROM `wp_posts` WHERE ( `wp_posts`.`post_title` LIKE '%$long%' ESCAPE '\\' ) AND `wp_posts`.`post_content` NOT LIKE '%$long%' ESCAPE '\\'", array(), $none );
check( 'a long LIKE becomes instr', $s, "SELECT 1 FROM `wp_posts` WHERE ( instr(lower(`wp_posts`.`post_title`), lower('$long')) > 0 ) AND instr(lower(`wp_posts`.`post_content`), lower('$long')) = 0" );

list( $s ) = D1_Dialect::rewrite( "SELECT 1 FROM t WHERE c LIKE '%a\\%b$long%' ESCAPE '\\'", array(), $none );
check( 'an escaped % in a long LIKE is a literal', $s, "SELECT 1 FROM t WHERE instr(lower(c), lower('a%b$long')) > 0" );

list( $s ) = D1_Dialect::rewrite( "SELECT 1 FROM t WHERE c LIKE '%a%b$long%'", array(), $none );
check( 'a long LIKE with a % inside is left alone', $s, "SELECT 1 FROM t WHERE c LIKE '%a%b$long%'" );

// #836 (a): a long '%...%' whose only inner wildcards are '_' (WooCommerce's cart-page probe: block JSON with
// __woocommerceNamespace, never escaped) becomes an exact match with no LIKE. Proven by DIFFERENCE against SQLite's own
// LIKE, which this local SQLite runs without the platform's 50-byte cap: same rows, same NULLs, LIKE and NOT LIKE.
if ( ! class_exists( 'SQLite3' ) ) {
	$fail++;
	echo "FAIL #836 the differential check needs the sqlite3 extension (not skipped: a skip would read as a pass)\n";
} else {
	$db = new SQLite3( ':memory:' );
	$db->exec( 'CREATE TABLE t ( id INTEGER PRIMARY KEY, c TEXT )' );
	$seg  = str_repeat( 'wp:block ', 7 ); // 63 bytes: each test pattern is over the cap
	$pats = array(
		'%' . $seg . '_x_%',
		'%a_' . $seg . '%',
		'%' . $seg . '__ns' . $seg . '%',
		'%_' . $seg . '_%',
		'%' . $seg . 'Q_Q' . $seg . 'z%',
		'%' . str_replace( "'", "''", file_get_contents( __DIR__ . '/fixtures/wc-11.2.1-cart-content.txt' ) ) . '%',
	);
	$rows = array( null, '', 'x', $seg, $seg . 'AxB', $seg . 'AXB', 'pre ' . $seg . 'axb post', 'a ' . $seg, 'ab' . $seg, 'aZ' . $seg . 'tail',
		$seg . '..ns' . $seg, $seg . '.ns' . $seg, $seg . 'ééns' . $seg, 'X' . $seg . 'Y', $seg . $seg,
		strtoupper( $seg ) . 'qXq' . $seg . 'Z', $seg . 'q' . $seg . 'QzQ' . $seg . 'z', $seg . 'Q_Q' . $seg,
		file_get_contents( __DIR__ . '/fixtures/wc-11.2.1-cart-content.txt' ), 'x' . file_get_contents( __DIR__ . '/fixtures/wc-11.2.1-cart-content.txt' ) . 'x' );
	$ins = $db->prepare( 'INSERT INTO t ( c ) VALUES ( :c )' );
	foreach ( $rows as $r ) { $ins->bindValue( ':c', $r, null === $r ? SQLITE3_NULL : SQLITE3_TEXT ); $ins->execute(); $ins->reset(); }
	$read = function ( $sql ) use ( $db ) { $o = array(); $q = $db->query( $sql ); if ( ! $q ) { return 'error: ' . $db->lastErrorMsg(); } while ( $row = $q->fetchArray( SQLITE3_NUM ) ) { $o[] = $row; } return $o; };
	foreach ( $pats as $n => $pat ) {
		foreach ( array( 'LIKE', 'NOT LIKE' ) as $op ) {
			$orig = "SELECT id, c $op '$pat' FROM t ORDER BY id";
			list( $s ) = D1_Dialect::rewrite( $orig, array(), $none );
			check( "#836 pattern $n $op: no LIKE is left", false === stripos( $s, ' LIKE ' ), true );
			check( "#836 pattern $n $op: the same answer as SQLite LIKE, row by row (NULL kept)", $read( $s ), $read( $orig ) );
		}
	}
	$hit = $read( "SELECT count(*) FROM t WHERE c LIKE '" . $pats[5] . "'" );
	check( '#836 the WooCommerce cart probe matches the two rows that hold the cart content (the oracle is not empty)', $hit, array( array( 2 ) ) );
}

list( $s ) = D1_Dialect::rewrite( "SELECT 1 FROM t WHERE c LIKE '%short%'", array(), $none );
check( 'a short LIKE is left alone', $s, "SELECT 1 FROM t WHERE c LIKE '%short%'" );

// #805: the Durable Object's SQLite caps a LIKE pattern at 50 bytes (measured: 50 passes, 51 fails). Over the cap, the
// single-literal shapes that are not '%lit%' become plain comparisons, with the same ASCII-only case folding as LIKE.
// At or under 50 bytes nothing changes, so SQLite's own LIKE (and its index range for a prefix) stands.
list( $s ) = D1_Dialect::rewrite( "SELECT 1 FROM t WHERE c LIKE '$long'", array(), $none );
check( '#805 an exact long LIKE becomes lower() equality', $s, "SELECT 1 FROM t WHERE lower(c) = lower('$long')" );

list( $s ) = D1_Dialect::rewrite( "SELECT 1 FROM t WHERE c NOT LIKE '$long'", array(), $none );
check( '#805 an exact long NOT LIKE becomes lower() inequality', $s, "SELECT 1 FROM t WHERE lower(c) <> lower('$long')" );

list( $s ) = D1_Dialect::rewrite( "SELECT 1 FROM t WHERE c LIKE '$long%'", array(), $none );
check( '#805 a long prefix LIKE becomes instr() = 1', $s, "SELECT 1 FROM t WHERE instr(lower(c), lower('$long')) = 1" );

list( $s ) = D1_Dialect::rewrite( "SELECT 1 FROM t WHERE c NOT LIKE '$long%'", array(), $none );
check( '#805 a long prefix NOT LIKE becomes instr() <> 1', $s, "SELECT 1 FROM t WHERE instr(lower(c), lower('$long')) <> 1" );

list( $s ) = D1_Dialect::rewrite( "SELECT 1 FROM t WHERE c LIKE 'a\\_b$long' ESCAPE '\\'", array(), $none );
check( '#805 an escaped _ in a long exact LIKE is a literal', $s, "SELECT 1 FROM t WHERE lower(c) = lower('a_b$long')" );

$login = 'pf805-' . str_repeat( 'x', 50 );
list( $s ) = D1_Dialect::rewrite( "SELECT `wp_users`.`ID` FROM `wp_users` WHERE 1 = 1 AND ( `user_login` LIKE '$login' ESCAPE '\\' ) ORDER BY `user_login` ASC", array(), $none );
check( '#805 WP_User_Query exact search for a 56-character login', $s, "SELECT `wp_users`.`ID` FROM `wp_users` WHERE 1 = 1 AND ( lower(`user_login`) = lower('$login') ) ORDER BY `user_login` ASC" );

list( $s ) = D1_Dialect::rewrite( "SELECT 1 FROM t WHERE c LIKE 'a_b$long%'", array(), $none );
check( '#805 a long prefix with a wildcard inside is left alone', $s, "SELECT 1 FROM t WHERE c LIKE 'a_b$long%'" );

$fifty = str_repeat( 'a', 50 );
list( $s ) = D1_Dialect::rewrite( "SELECT 1 FROM t WHERE c LIKE '$fifty' AND d LIKE '" . str_repeat( 'a', 49 ) . "%'", array(), $none );
check( '#805 exact and prefix at the 50-byte cap are left alone', $s, "SELECT 1 FROM t WHERE c LIKE '$fifty' AND d LIKE '" . str_repeat( 'a', 49 ) . "%'" );

list( $s ) = D1_Dialect::rewrite( "SELECT 1 FROM t WHERE c LIKE 'a$fifty'", array(), $none );
check( '#805 an exact LIKE of 51 bytes is rewritten', $s, "SELECT 1 FROM t WHERE lower(c) = lower('a$fifty')" );

// #805: the rewrite's trigger regex gave up on a very long pattern (PCRE), so a '%lit%' of about 50,000 bytes was never
// rewritten and failed (measured: 50,023 bytes passed, 50,024 failed).
$huge = str_repeat( 'a', 50022 );
list( $s ) = D1_Dialect::rewrite( "SELECT 1 FROM t WHERE c LIKE '%$huge%'", array(), $none );
check( '#805 a 50,024-byte %literal% still becomes instr', $s === "SELECT 1 FROM t WHERE instr(lower(c), lower('$huge')) > 0", true );

$body = str_repeat( "it''s ", 20000 );
list( $s, $p ) = D1_Dialect::rewrite( "INSERT INTO `wp_posts` (`post_content`, `post_title`) VALUES ('$body', 'small')", array(), $none );
check( 'a statement over 90 KB binds its long strings', array( $s, strlen( $p[0] ), substr( $p[0], 0, 6 ) ), array( "INSERT INTO `wp_posts` (`post_content`, `post_title`) VALUES (?, 'small')", 100000, "it's i" ) );

list( $s ) = D1_Dialect::rewrite( "SELECT MIN ( `d` ) AS `m` FROM ( ( SELECT `d` FROM `a` WHERE `x` = 1 ) UNION ALL ( SELECT `d` FROM `b` ) ) AS `t`", array(), $none );
check( 'parentheses around UNION parts are removed', preg_replace( '/\s+/', ' ', $s ), "SELECT MIN ( `d` ) AS `m` FROM ( SELECT `d` FROM `a` WHERE `x` = 1 UNION ALL SELECT `d` FROM `b` ) AS `t`" );

list( $s ) = D1_Dialect::rewrite( "SELECT * FROM ( ( SELECT `d` FROM `a` ORDER BY `d` LIMIT 1 ) UNION ( SELECT `d` FROM `b` ) ) AS `t`", array(), $none );
check( 'a UNION part with LIMIT becomes a subquery', preg_replace( '/\s+/', ' ', $s ), "SELECT * FROM ( SELECT * FROM ( SELECT `d` FROM `a` ORDER BY `d` LIMIT 1 ) UNION SELECT `d` FROM `b` ) AS `t`" );

echo $fail ? "$fail failed\n" : "all passed\n";
exit( $fail ? 1 : 0 );
