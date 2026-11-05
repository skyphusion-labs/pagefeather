<?php
/**
 * Plugin Name: Query count header
 * Description: Sends x-d1-calls, the number of SQL queries of the request, so tests/a/bench.py and e2e.sh show a query count for C1 as they do for B and A.
 *
 * The header name is the one the harness reads. In C1 the queries go to SQLite
 * on the container disk, not to D1. There is no time per query: the SQLite
 * driver times queries only with SAVEQUERIES, which also stores a backtrace
 * for every query.
 *
 * The response is buffered, so the header can be sent at the end of the
 * request. The count is taken on the shutdown action at priority 0, before
 * wp_ob_end_flush_all (priority 1) sends the buffer. Queries that run after
 * that (for example woo-edge.php's deferred option writes) are not counted.
 * Not for php-cli (install.php, wp-cron.php): the built-in server is cli-server.
 */
if ( 'cli-server' === PHP_SAPI ) {
	ob_start();
	add_action(
		'shutdown',
		function () {
			global $wpdb;
			if ( ! headers_sent() && isset( $wpdb->num_queries ) ) {
				header( 'x-d1-calls: ' . (int) $wpdb->num_queries );
			}
		},
		0
	);
}
