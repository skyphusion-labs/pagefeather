<?php
/**
 * #498: session state across Hyperdrive's pooled origin connections. No database: a fake Worker
 * behaves as Hyperdrive in transaction mode does. Outside a transaction, each statement runs on the
 * NEXT of 2 origin connections (round robin); inside BEGIN/START TRANSACTION .. COMMIT/ROLLBACK, on
 * one. FOUND_ROWS() and LAST_INSERT_ID() read only their own connection's state, as MySQL does.
 *
 *   php tests/a/found-rows-test.php [path/to/hyperdrive-db.php]
 *
 * Checks:
 * - a list query with SQL_CALC_FOUND_ROWS then SELECT FOUND_ROWS(), 50 times: the total is N every time;
 * - inside a transaction a plugin opened, no BEGIN or COMMIT of ours is sent (it would commit theirs);
 * - INSERT ... LAST_INSERT_ID(expr) then SELECT LAST_INSERT_ID() (WooCommerce QRLoginRateLimits): its value;
 * - control: on main's drop-in the same reads come back 0 (the test can see the defect).
 */
$DROPIN = $argv[1] ?? __DIR__ . '/../../spikes/b2-wordpress/php/hyperdrive-db.php';
$fails  = 0;
$runs   = 0;
function check( $name, $got, $want ) {
	global $fails, $runs;
	++$runs;
	if ( $got === $want ) { echo "ok   $name\n"; return; }
	++$fails;
	echo "FAIL $name\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
}

define( 'DB_USER', 'u' );
define( 'DB_PASSWORD', 'p' );
define( 'DB_NAME', 'n' );
define( 'DB_HOST', 'h' );
function apply_filters( $hook, $v ) { return $v; }
class wpdb {
	public $ready = true, $last_error = '', $last_query, $func_call, $insert_id = 0, $rows_affected = 0, $num_rows = 0;
	public $num_queries = 0, $last_result = array(), $result, $col_info, $dbh, $has_connected;
	public function __construct( $u, $p, $n, $h ) {}
	public function flush() { $this->last_result = array(); $this->col_info = null; }
	public function print_error( $e = '' ) {}
	public function add_placeholder_escape( $s ) { return $s; }
	public function get_var( $q ) {
		$this->query( $q );
		if ( ! $this->last_result ) { return null; }
		$row = array_values( get_object_vars( $this->last_result[0] ) );
		return $row ? $row[0] : null;
	}
}

// The fake Hyperdrive: 2 origin connections, each with its own FOUND_ROWS and LAST_INSERT_ID.
$N    = 37;               // the rows the list matches
$CONN = array( array( 'found' => 0, 'lii' => 0 ), array( 'found' => 0, 'lii' => 0 ) );
$NEXT = 0;                // the next connection a statement outside a transaction takes
$PIN  = null;             // the connection a transaction holds
$SENT = array();
function skyphusion_worker_call( $json ) {
	global $CONN, $NEXT, $PIN, $SENT, $N;
	$m   = json_decode( $json, true );
	$sql = $m['mysql'];
	$SENT[] = $sql;
	$c = ( null !== $PIN ) ? $PIN : ( $NEXT++ % 2 );
	if ( preg_match( '/^\s*(BEGIN|START\s+TRANSACTION)\b/i', $sql ) ) { $PIN = $c; return json_encode( array( 'ok' => true, 'affected' => 0, 'insert_id' => 0 ) ); }
	if ( preg_match( '/^\s*(COMMIT|ROLLBACK)\b/i', $sql ) ) { $PIN = null; return json_encode( array( 'ok' => true, 'affected' => 0, 'insert_id' => 0 ) ); }
	if ( preg_match( '/SQL_CALC_FOUND_ROWS/i', $sql ) ) {
		$CONN[ $c ]['found'] = $N;
		return json_encode( array( 'ok' => true, 'columns' => array( 'ID' ), 'rows' => array( array( '1' ) ) ) );
	}
	if ( preg_match( '/^\s*SELECT\s+FOUND_ROWS\(\)/i', $sql ) ) {
		$v = $CONN[ $c ]['found'];
		$CONN[ $c ]['found'] = 0; // the next statement on this connection resets it, as MySQL does
		return json_encode( array( 'ok' => true, 'columns' => array( 'FOUND_ROWS()' ), 'rows' => array( array( (string) $v ) ) ) );
	}
	if ( preg_match( '/^\s*SELECT\s+LAST_INSERT_ID\(\)/i', $sql ) ) {
		return json_encode( array( 'ok' => true, 'columns' => array( 'LAST_INSERT_ID()' ), 'rows' => array( array( (string) $CONN[ $c ]['lii'] ) ) ) );
	}
	if ( preg_match( '/^\s*INSERT\b/i', $sql ) ) {
		$id = preg_match( '/LAST_INSERT_ID\((\d+)\)/', $sql, $mm ) ? (int) $mm[1] : 501;
		$CONN[ $c ]['lii'] = $id;
		return json_encode( array( 'ok' => true, 'affected' => 1, 'insert_id' => $id ) );
	}
	return json_encode( array( 'ok' => true, 'columns' => array( 'a' ), 'rows' => array( array( '1' ) ) ) );
}
require $DROPIN;

// 1. WP_Query's pattern, 50 times.
$right = 0;
for ( $i = 0; $i < 50; $i++ ) {
	$wpdb->query( "SELECT SQL_CALC_FOUND_ROWS wp_posts.ID FROM wp_posts WHERE 1=1 LIMIT 0, 1" );
	$right += ( (string) $N === (string) $wpdb->get_var( 'SELECT FOUND_ROWS()' ) ) ? 1 : 0;
}
check( '#498: X-WP-Total (FOUND_ROWS) equals N on 50 of 50 reads', $right, 50 );

// 2. Inside a transaction a plugin opened: no BEGIN/COMMIT of ours (a second BEGIN would commit theirs).
$wpdb->query( 'START TRANSACTION' );
$SENT = array();
$wpdb->query( "SELECT SQL_CALC_FOUND_ROWS ID FROM wp_posts LIMIT 1" );
$t = $wpdb->get_var( 'SELECT FOUND_ROWS()' );
$ours = array_values( array_filter( $SENT, function ( $s ) { return (bool) preg_match( '/^\s*(BEGIN|COMMIT|START)/i', $s ); } ) );
check( '#498: inside an open transaction no BEGIN or COMMIT is sent', $ours, array() );
check( '#498: and the total is still N', (string) $t, (string) $N );
$wpdb->query( 'COMMIT' );

// 3. WooCommerce QRLoginRateLimits: INSERT ... LAST_INSERT_ID(expr), then SELECT LAST_INSERT_ID().
$right = 0;
for ( $i = 1; $i <= 20; $i++ ) {
	$wpdb->query( "INSERT INTO wp_wc_rate_limits (rate_limit_key) VALUES ('k') ON DUPLICATE KEY UPDATE rate_limit_id = LAST_INSERT_ID($i)" );
	$right += ( (string) $i === (string) $wpdb->get_var( 'SELECT LAST_INSERT_ID()' ) ) ? 1 : 0;
}
check( '#498: SELECT LAST_INSERT_ID() right after the write returns that write\'s id (20 of 20)', $right, 20 );

// 4. A FOUND_ROWS() not right after a calc query is sent as before (no made-up answer).
$wpdb->query( "SELECT SQL_CALC_FOUND_ROWS ID FROM wp_posts LIMIT 1" );
$wpdb->query( 'SELECT 1' );
$SENT = array();
$wpdb->get_var( 'SELECT FOUND_ROWS()' );
check( 'a FOUND_ROWS() that does not follow the calc query goes to the database', $SENT, array( 'SELECT FOUND_ROWS()' ) );

echo "$runs checks, $fails failed\n";
exit( $fails ? 1 : 0 );
