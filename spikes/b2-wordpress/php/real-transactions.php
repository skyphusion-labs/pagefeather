<?php
/**
 * Real SQL transactions for b-dosql (issue #60).
 *
 * On b-dosql the database is the PHP object's own SQLite. Its API refuses
 * BEGIN and SAVEPOINT (only ctx.storage.transaction() and transactionSync()),
 * and a storage transaction held open across awaits neither captures
 * statements made from outside its callback nor survives an outbound fetch()
 * (measured 2026-11-06, docs/approach-b.md 8l). So php/d1-pdo.php answered
 * BEGIN and COMMIT in PHP, and ROLLBACK undid nothing.
 *
 * This mu-plugin makes a transaction that PHP starts through $wpdb real, with
 * SQLite's documented undo technique: while a transaction is open, triggers
 * record the inverse of each row change, and ROLLBACK replays them (index.js,
 * txnOp). It watches the query filter, which WordPress applies to every query,
 * for the MySQL transaction statements:
 *   START TRANSACTION, BEGIN [WORK]           a transaction begins (an open one is committed first, as MySQL does)
 *   COMMIT [WORK]                             kept
 *   ROLLBACK [WORK]                           undone
 *   SAVEPOINT x, ROLLBACK [WORK] TO [SAVEPOINT] x, RELEASE SAVEPOINT x
 *   CREATE, ALTER, DROP, RENAME, TRUNCATE     an open transaction is committed first (MySQL's implicit commit)
 * The SQLite driver's own wrapper transactions (around each statement it
 * translates) do not pass the query filter, so they cost nothing here.
 * A transaction still open at the end of the request is rolled back, as MySQL
 * does when a connection closes; writes outside a transaction stay.
 *
 * On only when the Worker defines JS_REAL_TRANSACTIONS: with the database in the
 * object (one writer). On D1 (b-do) a transaction is still not real.
 */

if ( ! defined( 'JS_REAL_TRANSACTIONS' ) || ! function_exists( 'post_message_to_js' ) ) {
	return;
}

add_filter(
	'query',
	function ( $query ) {
		$q = ltrim( (string) $query );
		// Most queries are SELECT, INSERT, UPDATE, DELETE, SHOW: leave fast.
		if ( '' === $q || false === strpos( 'SBCRADTsbcradt', $q[0] ) ) {
			return $query;
		}
		$op   = null;
		$name = null;
		if ( preg_match( '/^(START\s+TRANSACTION\b|BEGIN(\s+WORK)?\s*;?\s*$)/i', $q ) ) {
			$op = 'begin';
		} elseif ( preg_match( '/^COMMIT(\s+WORK)?\s*;?\s*$/i', $q ) ) {
			$op = 'commit';
		} elseif ( preg_match( '/^ROLLBACK(\s+WORK)?\s+TO\s+(SAVEPOINT\s+)?`?(\w+)`?\s*;?\s*$/i', $q, $m ) ) {
			$op   = 'rollback_to';
			$name = $m[3];
		} elseif ( preg_match( '/^ROLLBACK(\s+WORK)?\s*;?\s*$/i', $q ) ) {
			$op = 'rollback';
		} elseif ( preg_match( '/^SAVEPOINT\s+`?(\w+)`?\s*;?\s*$/i', $q, $m ) ) {
			$op   = 'savepoint';
			$name = $m[1];
		} elseif ( preg_match( '/^RELEASE\s+SAVEPOINT\s+`?(\w+)`?\s*;?\s*$/i', $q, $m ) ) {
			$op   = 'release';
			$name = $m[1];
		} elseif ( preg_match( '/^(CREATE|ALTER|DROP|RENAME|TRUNCATE)\b/i', $q ) ) {
			$op = 'ddl';
		}
		if ( null !== $op ) {
			$reply = json_decode( post_message_to_js( json_encode( array( 'txn' => array( 'op' => $op, 'name' => $name ) ) ) ), true );
			if ( is_array( $reply ) && empty( $reply['ok'] ) && ! empty( $reply['error'] ) ) {
				error_log( 'real-transactions: ' . $op . ' ' . $name . ': ' . $reply['error'] );
			}
		}
		return $query;
	},
	PHP_INT_MAX
);
