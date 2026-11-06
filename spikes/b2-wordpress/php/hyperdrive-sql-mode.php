<?php
/**
 * sql_mode for WordPress on a strict MySQL server through Hyperdrive (issue #50).
 *
 * Stock wpdb relaxes sql_mode once per connection (set_sql_mode). Through
 * Hyperdrive that does not hold: Hyperdrive resets the session after each
 * statement, so a SET SESSION sql_mode reaches neither the next DML nor DDL
 * (measured on PlanetScale, 2026-11-06, tests/a2/probe E1). PlanetScale
 * (Vitess) is strict and its global mode cannot be changed. What does reach
 * the server (same probe):
 *
 * - a SET_VAR optimizer hint on SELECT, INSERT, UPDATE, REPLACE and DELETE
 *   (E3): the mode for that one statement, with no extra round trip;
 * - SET SESSION sql_mode inside BEGIN ... COMMIT, for DDL (E2). MySQL commits
 *   before DDL, but the DDL still runs in the relaxed mode.
 *
 * Opt-in: only when HYPERDRIVE_SQL_MODE is set to the mode, for example
 * ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION: the PHP constant (the
 * Worker writes it into wp-runtime.php from its var HYPERDRIVE_SQL_MODE), or
 * else the environment variable. Unset, nothing changes (variant a on MariaDB). These functions have no
 * WordPress dependency, so tests/a2/sql-mode-test.php can test them.
 */

/** The mode to use, or null when the feature is off. Only mode names and commas. */
function skyphusion_hd_sql_mode() {
	static $mode = false;
	if ( false === $mode ) {
		$v    = defined( 'HYPERDRIVE_SQL_MODE' ) ? (string) HYPERDRIVE_SQL_MODE : getenv( 'HYPERDRIVE_SQL_MODE' );
		$mode = ( false === $v || ! preg_match( '/^[A-Za-z_,]*$/', $v ) ) ? null : strtoupper( $v );
	}
	return $mode;
}

// Leading whitespace and comments (but not an optimizer hint /*+ ... */).
const SKYPHUSION_HD_LEAD = '(?:\s+|/\*(?!\+).*?\*/|--[^\n]*(?:\n|$)|#[^\n]*(?:\n|$))*';

/** True for CREATE and ALTER statements: these get the transaction wrap. */
function skyphusion_hd_is_ddl( $sql ) {
	return (bool) preg_match( '~^' . SKYPHUSION_HD_LEAD . '(create|alter)\b~is', $sql );
}

/**
 * The statement with a SET_VAR(sql_mode=...) hint right after its first
 * keyword, when that keyword is SELECT, INSERT, UPDATE, REPLACE or DELETE.
 * An existing hint comment right after the keyword gets the SET_VAR added to
 * it (MySQL reads one hint comment there). Anything else is returned as is:
 * a statement that starts with "(" (a UNION of parenthesized SELECTs) or WITH
 * has its first SELECT inside, where SET_VAR is ignored.
 */
function skyphusion_hd_hint( $sql, $mode ) {
	$set = "SET_VAR(sql_mode='" . $mode . "')";
	$re  = '~^(' . SKYPHUSION_HD_LEAD . ')(select|insert|update|replace|delete)\b(\s*/\*\+)?~is';
	if ( ! preg_match( $re, $sql, $m ) ) {
		return $sql;
	}
	$head = $m[1] . $m[2];
	$rest = substr( $sql, strlen( $m[0] ) );
	if ( ! empty( $m[3] ) ) {
		return $head . ' /*+ ' . $set . ' ' . ltrim( $rest );
	}
	return $head . ' /*+ ' . $set . ' */' . $rest;
}
