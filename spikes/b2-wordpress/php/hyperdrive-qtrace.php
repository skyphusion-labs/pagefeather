<?php
/**
 * #296 step 3, measure first: the PHP half of the query trace (the Worker half is qtrace.mjs). While the trace is on
 * for a request, each query on the bridge carries its caller, "<area>:<file>::<function>", so the Worker can say
 * which plugin and which function the round trips come from. Measure only; nothing changes when it is off.
 *
 * On: the request has x-pf-qtrace: 1 AND the Worker says yes (it checks the spike token, which PHP never sees).
 * Without the header PHP never asks. The caller is built from frames WITHOUT their arguments (no row data).
 */

/** True when this request's queries carry their caller. Asks the Worker once per request. */
function skyphusion_hd_qtrace_on() {
	if ( ! isset( $GLOBALS['skyphusion_hd_qtrace'] ) ) {
		$GLOBALS['skyphusion_hd_qtrace'] = isset( $_SERVER['HTTP_X_PF_QTRACE'] ) && '1' === $_SERVER['HTTP_X_PF_QTRACE']
			&& '1' === (string) skyphusion_worker_call( json_encode( array( 'qtraceOn' => 1 ) ) );
	}
	return $GLOBALS['skyphusion_hd_qtrace'];
}

/**
 * The query's caller: the first frame outside the database layer (the drop-in, its helpers and class-wpdb.php),
 * named by area, file and the function that line is in (the next frame's function). $frames is for the tests.
 */
function skyphusion_hd_caller( $frames = null ) {
	if ( null === $frames ) {
		$frames = debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS, 40 );
	}
	$frames = array_values( $frames );
	$skip   = array( 'db.php', 'hyperdrive-qtrace.php', 'hyperdrive-mysqli.php', 'hyperdrive-sql-mode.php', 'hyperdrive-literals.php', 'class-wpdb.php', 'wp-db.php' );
	foreach ( $frames as $k => $fr ) {
		if ( empty( $fr['file'] ) ) {
			continue;
		}
		$file = str_replace( '\\', '/', $fr['file'] );
		$base = basename( $file );
		if ( in_array( $base, $skip, true ) && ( 'class-wpdb.php' === $base || 'wp-db.php' === $base || false !== strpos( $file, '/wp-content/' ) ) ) {
			continue;
		}
		if ( preg_match( '#/wp-content/plugins/([^/]+)/#', $file, $m ) ) {
			$area = 'plugin:' . $m[1];
		} elseif ( preg_match( '#/wp-content/themes/([^/]+)/#', $file, $m ) ) {
			$area = 'theme:' . $m[1];
		} elseif ( false !== strpos( $file, '/wp-content/mu-plugins/' ) ) {
			$area = 'mu';
		} elseif ( false !== strpos( $file, '/wp-content/' ) ) {
			$area = 'dropin';
		} else {
			$area = 'core';
		}
		$next = isset( $frames[ $k + 1 ] ) ? $frames[ $k + 1 ] : null;
		$fn   = $next && ! empty( $next['function'] ) ? ( ! empty( $next['class'] ) ? $next['class'] . '->' : '' ) . $next['function'] : 'main';
		return substr( $area . ':' . $base . '::' . $fn, 0, 160 );
	}
	return '?';
}
