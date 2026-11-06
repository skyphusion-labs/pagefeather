<?php
/**
 * Plugin Name: C1 queue runner
 * Description: WP-Cron and Action Scheduler run from the container, not from visitor requests (issue #45).
 *
 * With DISABLE_WP_CRON, WooCommerce's Action Scheduler ran its queue through
 * an async loopback: the site sent a POST to its own admin-ajax.php through the
 * Worker, and that request ran one batch, then sleep( 5 ), then sent the next
 * one. Under load the chain stopped after 1 to 10 requests and the queue grew
 * (docs/approach-c1.md). With QUEUE_RUNNER=local, container/entrypoint.sh
 * requests http://127.0.0.1/wp-cron.php every CRON_SECONDS instead. That runs
 * the due WP-Cron events in PHP's own server, so the object cache (APCu) stays
 * coherent, and Action Scheduler's 'action_scheduler_run_queue' event processes
 * batches for up to AS_TIME_LIMIT seconds (5; Action Scheduler's own default is
 * 30). This plugin turns the async loopback off.
 *
 * Why 5 s: PHP's built-in server serves the connections one process has
 * accepted one at a time. A shopper whose connection lands on the process that
 * runs a 15 to 30 s cron request waited that long while other processes were
 * idle (measured 2026-11-06, docs/approach-c1.md, "Who passes the limit"). A
 * short run bounds that wait; CRON_SECONDS (10) keeps the queue's share of time
 * about what it was (5 s of every 15 s, against 30 s of every 90 s).
 *
 * Action Scheduler's WP-Cron event (action_scheduler_run_queue) is due only
 * once a minute, so with 5 s runs it alone would process a sixth of what it did.
 * So the local cron request also runs one queue batch itself whenever that event
 * is not due in this request (WP-Cron runs it when it is: never both).
 */
// The default is local, as in container/entrypoint.sh: only QUEUE_RUNNER=loopback
// keeps the async loopback.
if ( 'loopback' !== getenv( 'QUEUE_RUNNER' ) ) {
	add_filter( 'action_scheduler_allow_async_request_runner', '__return_false' );
	add_action(
		'wp_loaded',
		function () {
			if ( ! ( defined( 'DOING_CRON' ) && DOING_CRON ) || '127.0.0.1' !== ( $_SERVER['REMOTE_ADDR'] ?? '' ) ) {
				return;
			}
			$next = wp_next_scheduled( 'action_scheduler_run_queue', array( 'WP Cron' ) );
			if ( $next && $next <= time() ) {
				return; // WP-Cron runs the queue in this request.
			}
			do_action( 'action_scheduler_run_queue', 'C1 local' );
		}
	);
	add_filter(
		'action_scheduler_queue_runner_time_limit',
		function () {
			$s = (int) getenv( 'AS_TIME_LIMIT' );
			return $s > 0 ? $s : 5;
		}
	);
	// Before this runner, no WP-Cron event ran on c1 (DISABLE_WP_CRON). Core's
	// update checks would now send the site's versions and plugin list to
	// api.wordpress.org twice a day. The code is in the image and cannot be
	// updated in place (an update is a new image), so the checks do nothing
	// useful here: do not run them from the queue runner.
	add_action(
		'init',
		function () {
			foreach ( array( 'wp_version_check', 'wp_update_plugins', 'wp_update_themes', 'wp_maybe_auto_update' ) as $hook ) {
				remove_all_actions( $hook );
			}
		}
	);
}
