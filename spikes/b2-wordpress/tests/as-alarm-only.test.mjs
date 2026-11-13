// Action Scheduler runs only in the alarm (#358, php/action-scheduler-alarm-only.php): the REAL mu-plugin,
// run by the php CLI against a WordPress hook stub that honours priorities, and a stand-in for the pinned
// Action Scheduler (WooCommerce 11.2.1) that registers as it does: ActionScheduler_QueueRunner::init at
// `init` priority 1 adds `action_scheduler_run_queue` -> run() (the unbounded runner) and the `shutdown`
// dispatch; the async handler's handle() calls do_action('action_scheduler_run_queue') WITHOUT allow();
// allow() is has_action(run_queue) and the action_scheduler_allow_async_request_runner filter.
// - The reproduction: without the mu-plugin, an admin page dispatches the loopback and its handler runs
//   the unbounded runner.
// - The fix: no dispatch, no shutdown hook, and a direct hit of the handler runs nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const plugin = new URL('../php/action-scheduler-alarm-only.php', import.meta.url).pathname;
const harness = (withPlugin) => `<?php
$GLOBALS['h'] = array(); $GLOBALS['spy'] = array('runner' => 0, 'dispatched' => 0);
function add_action( $tag, $fn, $prio = 10, $n = 1 ) { $GLOBALS['h'][ $tag ][ $prio ][] = $fn; }
function add_filter( $tag, $fn, $prio = 10, $n = 1 ) { add_action( $tag, $fn, $prio, $n ); }
function remove_all_actions( $tag ) { unset( $GLOBALS['h'][ $tag ] ); }
function remove_action( $tag, $fn ) { if ( empty( $GLOBALS['h'][ $tag ] ) ) return; foreach ( $GLOBALS['h'][ $tag ] as $p => $fns ) { foreach ( $fns as $i => $f ) { if ( $f == $fn ) unset( $GLOBALS['h'][ $tag ][ $p ][ $i ] ); } } }
function has_action( $tag ) { if ( empty( $GLOBALS['h'][ $tag ] ) ) return false; foreach ( $GLOBALS['h'][ $tag ] as $fns ) { if ( $fns ) return true; } return false; }
function do_action( $tag, ...$a ) { if ( empty( $GLOBALS['h'][ $tag ] ) ) return; ksort( $GLOBALS['h'][ $tag ] ); foreach ( $GLOBALS['h'][ $tag ] as $fns ) { foreach ( $fns as $f ) { call_user_func_array( $f, $a ); } } }
function apply_filters( $tag, $v ) { if ( empty( $GLOBALS['h'][ $tag ] ) ) return $v; ksort( $GLOBALS['h'][ $tag ] ); foreach ( $GLOBALS['h'][ $tag ] as $fns ) { foreach ( $fns as $f ) { $v = call_user_func( $f, $v ); } } return $v; }
function __return_false() { return false; }
function is_admin() { return true; }
// The stand-in for the pinned Action Scheduler.
class ActionScheduler_QueueRunner {
	private static $i;
	static function instance() { return self::$i ?: ( self::$i = new self() ); }
	function init() { add_action( 'action_scheduler_run_queue', array( self::instance(), 'run' ) ); $this->hook_dispatch_async_request(); }
	function hook_dispatch_async_request() { add_action( 'shutdown', array( $this, 'maybe_dispatch_async_request' ) ); }
	function unhook_dispatch_async_request() { remove_action( 'shutdown', array( $this, 'maybe_dispatch_async_request' ) ); }
	function maybe_dispatch_async_request() { if ( is_admin() ) { As_Async::maybe_dispatch(); } }
	function run( $ctx = 'WP Cron' ) { $GLOBALS['spy']['runner']++; }
}
class As_Async {
	static function allow() { return apply_filters( 'action_scheduler_allow_async_request_runner', has_action( 'action_scheduler_run_queue' ) ? true : false ); }
	static function maybe_dispatch() { if ( self::allow() ) { $GLOBALS['spy']['dispatched']++; } }
	static function handle() { do_action( 'action_scheduler_run_queue', 'Async Request' ); }
}
add_action( 'init', array( ActionScheduler_QueueRunner::instance(), 'init' ), 1, 0 );
${withPlugin ? `require ${JSON.stringify(plugin)};` : ''}
do_action( 'init' );
$after_init = array( 'run_queue_hooked' => has_action( 'action_scheduler_run_queue' ), 'shutdown_hooked' => has_action( 'shutdown' ), 'filter' => apply_filters( 'action_scheduler_allow_async_request_runner', true ) );
do_action( 'shutdown' );            // an admin page ends: the dispatch check
As_Async::handle();                 // a direct hit of admin-ajax.php?action=as_async_request_queue_runner
echo json_encode( array_merge( $after_init, $GLOBALS['spy'] ) );
`;
function run(withPlugin) {
	const d = mkdtempSync(join(tmpdir(), 'as-alarm-only-'));
	try {
		writeFileSync(join(d, 't.php'), harness(withPlugin));
		const r = spawnSync('php', ['-n', join(d, 't.php')], { encoding: 'utf8' });
		assert.equal(r.status, 0, r.stderr + r.stdout);
		return JSON.parse(r.stdout);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
}
test('THE REPRODUCTION (#358): without the mu-plugin an admin page dispatches the async runner, and its handler runs the unbounded runner', (t) => {
	if (spawnSync('php', ['-v']).status !== 0) return t.skip('php CLI not found');
	const r = run(false);
	assert.equal(r.dispatched, 1, 'the shutdown check dispatched a loopback');
	assert.equal(r.runner, 1, 'the handler ran ActionScheduler_QueueRunner::run (unbounded)');
});
test('FIXED: no dispatch, no shutdown hook, and a direct hit of the handler runs nothing', (t) => {
	if (spawnSync('php', ['-v']).status !== 0) return t.skip('php CLI not found');
	const r = run(true);
	assert.equal(r.filter, false, 'the allow filter answers false');
	assert.equal(r.shutdown_hooked, false, 'the shutdown dispatch hook is gone');
	assert.equal(r.run_queue_hooked, false, 'action_scheduler_run_queue has no callback in a request');
	assert.equal(r.dispatched, 0);
	assert.equal(r.runner, 0, 'the unbounded runner never ran');
});
