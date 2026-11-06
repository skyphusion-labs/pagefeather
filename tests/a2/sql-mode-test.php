<?php
/**
 * Tests for spikes/b2-wordpress/php/hyperdrive-sql-mode.php and the routing in
 * hyperdrive-db.php (issue #50). No database: a fake Worker call records what
 * the drop-in sends.
 *
 *   php tests/a2/sql-mode-test.php off   # HYPERDRIVE_SQL_MODE unset: nothing changes
 *   php tests/a2/sql-mode-test.php on    # set: hints and the DDL wrap
 *   php tests/a2/sql-mode-test.php bad   # set to a value with a quote: refused, off
 *   php tests/a2/sql-mode-test.php const # the PHP constant (as the Worker writes it) wins over the environment
 *
 * Each run is its own process, because the mode is read once per process.
 * Exit 0 when every check passes.
 */
$which = $argv[1] ?? 'on';
$MODE  = 'ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
if ( 'on' === $which ) {
	putenv( 'HYPERDRIVE_SQL_MODE=' . $MODE );
} elseif ( 'const' === $which ) {
	define( 'HYPERDRIVE_SQL_MODE', $MODE );
	putenv( 'HYPERDRIVE_SQL_MODE=NO_ENGINE_SUBSTITUTION' );
} elseif ( 'bad' === $which ) {
	putenv( "HYPERDRIVE_SQL_MODE=NO_ENGINE_SUBSTITUTION') */ DROP TABLE x; -- " );
}
$fails = 0;
$runs  = 0;
function check( $name, $got, $want ) {
	global $fails, $runs;
	++$runs;
	if ( $got === $want ) {
		echo "ok   $name\n";
		return;
	}
	++$fails;
	echo "FAIL $name\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
}

// ---- A minimal wpdb, enough for the drop-in's query() --------------------
define( 'DB_USER', 'u' );
define( 'DB_PASSWORD', 'p' );
define( 'DB_NAME', 'n' );
define( 'DB_HOST', 'h' );
function apply_filters( $hook, $v ) {
	return $v;
}
class wpdb {
	public $ready = true, $last_error = '', $last_query, $func_call, $insert_id = 0, $rows_affected = 0, $num_rows = 0;
	public $num_queries = 0, $last_result = array(), $result, $col_info, $dbh, $has_connected;
	public function __construct( $u, $p, $n, $h ) {}
	public function flush() {
		$this->last_result = array();
		$this->col_info    = null;
	}
	public function print_error( $e = '' ) {}
	public function add_placeholder_escape( $s ) {
		return $s;
	}
}
// The fake Worker: records each message, answers OK; DDL that contains FAILME fails.
$SENT = array();
function skyphusion_worker_call( $json ) {
	global $SENT;
	$m      = json_decode( $json, true );
	$SENT[] = $m['mysql'];
	if ( false !== strpos( $m['mysql'], 'FAILME' ) ) {
		return json_encode( array( 'ok' => false, 'error' => 'Invalid default value (errno 1067)' ) );
	}
	if ( preg_match( '/^\s*(select|show)/i', $m['mysql'] ) || preg_match( '/^\s*\/\*/', $m['mysql'] ) ) {
		return json_encode( array( 'ok' => true, 'columns' => array( 'a' ), 'rows' => array( array( '1' ) ) ) );
	}
	return json_encode( array( 'ok' => true, 'affected' => 1, 'insert_id' => 7 ) );
}
require __DIR__ . '/../../spikes/b2-wordpress/php/hyperdrive-db.php';
function sent( $sql ) {
	global $wpdb, $SENT;
	$SENT = array();
	$wpdb->query( $sql );
	return $SENT;
}

if ( 'const' === $which ) {
	check( 'const: the constant wins over the environment', skyphusion_hd_sql_mode(), $MODE );
	check( 'const: SELECT carries the hint', sent( 'SELECT 1' ), array( "SELECT /*+ SET_VAR(sql_mode='$MODE') */ 1" ) );
	echo "$runs checks, $fails failed\n";
	exit( $fails ? 1 : 0 );
}
if ( 'bad' === $which ) {
	check( 'bad: a mode that is not names and commas is refused', skyphusion_hd_sql_mode(), null );
	check( 'bad: SELECT unchanged', sent( 'SELECT 1' ), array( 'SELECT 1' ) );
	echo "$runs checks, $fails failed\n";
	exit( $fails ? 1 : 0 );
}
if ( 'off' === $which ) {
	// Unset: the drop-in sends WordPress's SQL unchanged, as before #50.
	check( 'off: mode is null', skyphusion_hd_sql_mode(), null );
	check( 'off: SELECT unchanged', sent( 'SELECT 1' ), array( 'SELECT 1' ) );
	$ddl = "CREATE TABLE wp_x (d datetime NOT NULL default '0000-00-00 00:00:00')";
	check( 'off: DDL unchanged, no wrap', sent( $ddl ), array( $ddl ) );
	echo "$runs checks, $fails failed\n";
	exit( $fails ? 1 : 0 );
}

// ---- The hint helper ------------------------------------------------------
$H = "/*+ SET_VAR(sql_mode='$MODE') */";
$cases = array(
	'SELECT'                    => array( 'SELECT * FROM wp_posts', "SELECT $H * FROM wp_posts" ),
	'lowercase select'          => array( 'select ID from wp_posts', "select $H ID from wp_posts" ),
	'INSERT'                    => array( "INSERT INTO `wp_posts` (`post_date_gmt`) VALUES ('0000-00-00 00:00:00')", "INSERT $H INTO `wp_posts` (`post_date_gmt`) VALUES ('0000-00-00 00:00:00')" ),
	'INSERT IGNORE'             => array( 'INSERT IGNORE INTO wp_options VALUES (1)', "INSERT $H IGNORE INTO wp_options VALUES (1)" ),
	'UPDATE'                    => array( 'UPDATE wp_posts SET post_status = 1', "UPDATE $H wp_posts SET post_status = 1" ),
	'REPLACE'                   => array( 'REPLACE INTO wp_x VALUES (1)', "REPLACE $H INTO wp_x VALUES (1)" ),
	'DELETE'                    => array( 'DELETE FROM wp_x WHERE a = 1', "DELETE $H FROM wp_x WHERE a = 1" ),
	'leading whitespace'        => array( "\n\t  SELECT 1", "\n\t  SELECT $H 1" ),
	'leading block comment'     => array( '/* wc */ SELECT 1', "/* wc */ SELECT $H 1" ),
	'leading line comment'      => array( "-- note\nSELECT 1", "-- note\nSELECT $H 1" ),
	'leading hash comment'      => array( "# note\nSELECT 1", "# note\nSELECT $H 1" ),
	'existing hint merged'      => array( 'SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1', "SELECT /*+ SET_VAR(sql_mode='$MODE') MAX_EXECUTION_TIME(1000) */ 1" ),
	'SELECT FOUND_ROWS()'       => array( 'SELECT FOUND_ROWS()', "SELECT $H FOUND_ROWS()" ),
	'SELECTION is not SELECT'   => array( 'SELECTION', 'SELECTION' ),
	'parenthesized UNION as is' => array( '(SELECT 1) UNION (SELECT 2)', '(SELECT 1) UNION (SELECT 2)' ),
	'WITH as is'                => array( 'WITH a AS (SELECT 1) SELECT * FROM a', 'WITH a AS (SELECT 1) SELECT * FROM a' ),
	'SHOW as is'                => array( 'SHOW TABLES LIKE \'wp_posts\'', 'SHOW TABLES LIKE \'wp_posts\'' ),
	'SET as is'                 => array( 'SET autocommit = 1', 'SET autocommit = 1' ),
	'DDL as is (no hint)'       => array( 'CREATE TABLE t (a int)', 'CREATE TABLE t (a int)' ),
	'string with SELECT inside' => array( "UPDATE wp_x SET v = 'SELECT 1'", "UPDATE $H wp_x SET v = 'SELECT 1'" ),
);
foreach ( $cases as $name => list( $in, $want ) ) {
	check( "hint: $name", skyphusion_hd_hint( $in, $MODE ), $want );
}
foreach ( array( 'CREATE TABLE t (a int)' => true, "  create table t (a int)" => true, 'ALTER TABLE t ADD c int' => true, '/* x */ ALTER TABLE t' => true, 'SELECT 1' => false, 'DROP TABLE t' => false, 'CREATED' => false ) as $sql => $want ) {
	check( "is_ddl: $sql", skyphusion_hd_is_ddl( $sql ), $want );
}

// ---- The drop-in's routing ------------------------------------------------
check( 'on: mode read', skyphusion_hd_sql_mode(), $MODE );
check( 'on: SELECT carries the hint, one message', sent( 'SELECT 1' ), array( "SELECT $H 1" ) );
check( 'on: last_query is WordPress\'s own text', $wpdb->last_query, 'SELECT 1' );
$ddl = "CREATE TABLE wp_posts (post_date_gmt datetime NOT NULL default '0000-00-00 00:00:00')";
check( 'on: DDL is wrapped', sent( $ddl ), array( 'BEGIN', "SET SESSION sql_mode = '$MODE'", $ddl, 'COMMIT' ) );
$n = $wpdb->num_queries;
$r = $wpdb->query( 'ALTER TABLE wp_x FAILME' );
check( 'on: failed DDL returns false', $r, false );
check( 'on: failed DDL keeps the error', $wpdb->last_error, 'Invalid default value (errno 1067)' );
check( 'on: failed DDL still sends COMMIT', end( $SENT ), 'COMMIT' );
check( 'on: one logical query counted', $wpdb->num_queries, $n + 1 );
$r = $wpdb->query( "INSERT INTO wp_x (d) VALUES ('0000-00-00 00:00:00')" );
check( 'on: INSERT returns rows affected', $r, 1 );
check( 'on: INSERT keeps insert_id', $wpdb->insert_id, 7 );

echo "$runs checks, $fails failed\n";
exit( $fails ? 1 : 0 );
