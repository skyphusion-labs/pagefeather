<?php
/**
 * Plugin Name: Action Scheduler runs only in the alarm (b-dosql, #358)
 * Description: The object's alarm (runCron, index.js) is the only Action Scheduler runner: a bounded
 *   loop that calls process_action itself (#323, cron-bound.mjs). Action Scheduler's own queue runner
 *   (action_scheduler_run_queue, ActionScheduler_QueueRunner::run) is unbounded: on the sample store it
 *   grew the heap from 99.4 to 119.3 MiB and reset the isolate in 19 of 19 ticks (#335). The tick
 *   already skips it (#356). This stops the other way in: the async request runner.
 *
 * In the pinned Action Scheduler (WooCommerce 11.2.1):
 *   - ActionScheduler_QueueRunner::maybe_dispatch_async_request runs on `shutdown` of every admin
 *     page (at most once a minute, a lock that is a database write) and dispatches a loopback POST to
 *     admin-ajax.php?action=as_async_request_queue_runner when allow() says so;
 *   - ActionScheduler_AsyncRequest_QueueRunner::handle(), the loopback's handler, calls
 *     do_action('action_scheduler_run_queue') WITHOUT asking allow(): so a request that reaches that
 *     endpoint runs the unbounded runner, inside a page request on the PHP object.
 * So three things, each enough for one door:
 *   1. the action_scheduler_allow_async_request_runner filter answers false (no dispatch);
 *   2. the shutdown dispatch hook is removed (no lock write on every admin page either);
 *   3. action_scheduler_run_queue has no callback in a request, so even a direct hit of the
 *      endpoint runs nothing. The tick removes it too (#356). Tools > Scheduled Actions "Run" calls
 *      process_action directly and keeps working.
 */

add_filter( 'action_scheduler_allow_async_request_runner', '__return_false', PHP_INT_MAX );

add_action(
	'init',
	function () {
		if ( class_exists( 'ActionScheduler_QueueRunner' ) && method_exists( 'ActionScheduler_QueueRunner', 'instance' ) ) {
			$runner = ActionScheduler_QueueRunner::instance();
			if ( method_exists( $runner, 'unhook_dispatch_async_request' ) ) {
				$runner->unhook_dispatch_async_request();
			}
		}
		remove_all_actions( 'action_scheduler_run_queue' );
	},
	PHP_INT_MAX
);
