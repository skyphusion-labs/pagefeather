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
 * batches for up to 30 s. This plugin turns the async loopback off.
 */
// The default is local, as in container/entrypoint.sh: only QUEUE_RUNNER=loopback
// keeps the async loopback.
if ( 'loopback' !== getenv( 'QUEUE_RUNNER' ) ) {
	add_filter( 'action_scheduler_allow_async_request_runner', '__return_false' );
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
