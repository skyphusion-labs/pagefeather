// The cron tick's WP-Cron leg never runs Action Scheduler's queue runner (#335): the REAL runCron
// script from index.js, run by the php CLI against small WordPress and Action Scheduler stubs.
// A spy is registered on action_scheduler_run_queue, as Action Scheduler's init does at wp-load.
// - The reproduction: with the two #335 lines taken out of the rendered script, a due run_queue
//   event (the earliest, as it nearly always is: Action Scheduler schedules it every minute) takes
//   the tick's one WP-Cron slot and the unbounded runner runs. On the sample store that runner
//   reset the isolate in 19 of 19 ticks (fdprobe1112g, 2026-11-12).
// - The fix: the runner never runs, the slot goes to the next due event, and run_queue is not
//   unscheduled (Action Scheduler would only schedule it again).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const h = src.indexOf('async function runCron(');
assert.ok(h >= 0, 'runCron is in index.js');
const open = src.indexOf('php.run({ code: `', h) + 'php.run({ code: `'.length;
const close = src.indexOf('` });', open);
const tpl = src.slice(open, close);
// Evaluate the JS template literal as index.js does (its ${actions}, ${wpEvents}, ${cleanDue}).
const render = (actions, wpEvents) => new Function('actions', 'wpEvents', 'cleanDue', 'return `' + tpl + '`;')(actions, wpEvents, false);

const FIX_REMOVE = "remove_all_actions( 'action_scheduler_run_queue' );";
const FIX_SKIP = "if ( 'action_scheduler_run_queue' === $hook ) { $skipped[ $hook ] = 1; continue; }";

const STUBS = `<?php
$GLOBALS['spy'] = array( 'runner' => 0, 'ran' => array(), 'unscheduled' => array(), 'rescheduled' => array(), 'processed' => array() );
$GLOBALS['stub_hooks'] = array();
function add_action( $h, $f ) { $GLOBALS['stub_hooks'][ $h ][] = $f; }
function remove_all_actions( $h ) { unset( $GLOBALS['stub_hooks'][ $h ] ); }
// The claim order filter of the #357 email pass; this test does not model the claim order.
function add_filter( $h, $f ) {}
function remove_filter( $h, $f ) {}
function do_action_ref_array( $h, $args ) { $GLOBALS['spy']['ran'][] = $h; foreach ( isset( $GLOBALS['stub_hooks'][ $h ] ) ? $GLOBALS['stub_hooks'][ $h ] : array() as $f ) { call_user_func_array( $f, $args ); } }
function wp_cache_flush_runtime() {}
function wp_unschedule_event( $ts, $h, $a ) { $GLOBALS['spy']['unscheduled'][] = $h; }
function wp_reschedule_event( $ts, $s, $h, $a, $i = 0 ) { $GLOBALS['spy']['rescheduled'][] = $h; }
function _get_cron_array() { return json_decode( getenv( 'STUB_CRON' ), true ); }
class Stub_DB {
	public $prefix = 'wp_';
	// #1143 review: the oldest-email slot claims its action first (one atomic UPDATE); STUB_OLDEST_TAKEN=1 says another
	// runner already holds it (0 rows), so the leg must not run it.
	function query( $q ) { if ( false !== strpos( $q, 'SET claim_id = ' ) && false !== strpos( $q, 'AND claim_id = 0' ) ) { $GLOBALS['spy']['claimed_oldest'] = true; return getenv( 'STUB_OLDEST_TAKEN' ) ? 0 : 1; } return 0; }
	function prepare( $q, ...$a ) { return vsprintf( str_replace( array( '%s', '%d' ), array( "'%s'", '%d' ), $q ), $a ); }
	function get_var( $q ) { return false !== strpos( $q, 'scheduled_date_gmt' ) ? (int) getenv( 'STUB_DUE' ) : (int) getenv( 'STUB_PENDING' ); }
	// #1143: an id-list read ordered by scheduled date, newest first. In this store a larger id is a later schedule.
	function get_col( $q ) {
		// #1143 review: the oldest due, unclaimed email (STUB_OLDEST; none when unset).
		if ( false !== strpos( $q, 'ORDER BY a.scheduled_date_gmt ASC' ) ) { return getenv( 'STUB_OLDEST' ) ? array( (int) getenv( 'STUB_OLDEST' ) ) : array(); }
		if ( ! preg_match( '/action_id IN \\(([0-9, ]+)\\)/', $q, $m ) ) { return array(); }
		$ids = array_map( 'intval', explode( ',', $m[1] ) );
		rsort( $ids );
		return $ids;
	}
}
$GLOBALS['wpdb'] = new Stub_DB();
class Stub_Action { public $h; function __construct( $h ) { $this->h = $h; } function get_hook() { return $this->h; } }
class Stub_Claim { public $ids; function __construct( $ids ) { $this->ids = $ids; } function get_actions() { return $this->ids; } function get_id() { return 77; } }
class Stub_Store {
	// As Action Scheduler does (find_actions_by_claim_id): the claimed ids come back OLDEST first (11 is the oldest).
	function stake_claim( $n ) { return new Stub_Claim( array_slice( array( 11, 12, 13 ), 0, $n ) ); }
	function fetch_action( $id ) { return new Stub_Action( 'woocommerce_send_queued_transactional_email' ); }
	function release_claim( $c ) {}
}
class Stub_Runner { function process_action( $id, $ctx ) { $GLOBALS['spy']['processed'][] = $id; } }
class ActionScheduler { static function store() { return new Stub_Store(); } static function runner() { return new Stub_Runner(); } }
class ActionScheduler_QueueCleaner { function __construct( $s ) {} function reset_timeouts() {} function mark_failures() {} }
// Action Scheduler's init registers its queue runner on this hook during wp-load: the spy stands in.
add_action( 'action_scheduler_run_queue', function () { $GLOBALS['spy']['runner']++; } );
register_shutdown_function( function () { fwrite( STDERR, json_encode( $GLOBALS['spy'] ) ); } );
// The runtime's bridge to the Worker (#1120: the leg asks cronMore before each further action). STUB_MORE is the
// Worker's answer ('1' runs it); STUB_NO_BRIDGE leaves the function out, as a runtime without the bridge.
if ( ! getenv( 'STUB_NO_BRIDGE' ) ) {
	function post_message_to_js( $m ) {
		$d = json_decode( $m, true );
		if ( ! isset( $d['cronMore'] ) ) { return '1'; }
		// STUB_MORE_SEQ: the Worker's answers in turn (for the 2nd action, the 3rd, ...), then 'budget'.
		if ( getenv( 'STUB_MORE_SEQ' ) ) { static $i = 0; $seq = explode( ',', getenv( 'STUB_MORE_SEQ' ) ); return isset( $seq[ $i ] ) ? $seq[ $i++ ] : 'budget'; }
		return getenv( 'STUB_MORE' ) ?: '1';
	}
}
`;

// A due WP-Cron array: run_queue first (the earliest, as it nearly always is), then other hooks.
function cron(...hooks) {
	const now = Math.floor(Date.now() / 1000);
	const c = {};
	hooks.forEach((hk, i) => { c[now - 300 + i * 10] = { [hk]: { k: { schedule: 'hourly', args: [], interval: 3600 } } }; });
	return c;
}

function run({ code, crons, pending = 7, due = 3, more = '', noBridge = false, moreSeq = '', oldest = '', oldestTaken = false }) {
	const d = mkdtempSync(join(tmpdir(), 'cron-run-queue-'));
	try {
		writeFileSync(join(d, 'stubs.php'), STUBS);
		writeFileSync(join(d, 'cron.php'), code.replace("require '/wordpress/wp-load.php';", "require '" + join(d, 'stubs.php') + "';"));
		const r = spawnSync('php', ['-n', join(d, 'cron.php')], { env: { ...process.env, STUB_CRON: JSON.stringify(crons), STUB_PENDING: String(pending), STUB_DUE: String(due), STUB_MORE: more, STUB_NO_BRIDGE: noBridge ? '1' : '', STUB_MORE_SEQ: moreSeq, STUB_OLDEST: String(oldest), STUB_OLDEST_TAKEN: oldestTaken ? '1' : '' }, encoding: 'utf8' });
		assert.equal(r.status, 0, r.stderr + r.stdout);
		const out = JSON.parse(r.stdout.slice(r.stdout.lastIndexOf('{')));
		return { out, spy: JSON.parse(r.stderr) };
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
}

test('the rendered script carries both #335 lines (the test runs the real code)', () => {
	const code = render(1, 1);
	assert.ok(code.includes(FIX_REMOVE), 'the hook removal is in runCron');
	assert.ok(code.includes(FIX_SKIP), 'the slot skip is in runCron');
	assert.ok(code.indexOf(FIX_REMOVE) < code.indexOf('$crons = function_exists'), 'the hook is removed before the WP-Cron leg');
});

test('reproduction: without the #335 lines, run_queue takes the slot and the unbounded runner runs', () => {
	const code = render(1, 1).replace(FIX_REMOVE, '').replace(FIX_SKIP, '');
	const { out, spy } = run({ code, crons: cron('action_scheduler_run_queue', 'jetpack_clean_nonces') });
	assert.equal(spy.runner, 1, 'the queue runner ran');
	assert.deepEqual(spy.ran, ['action_scheduler_run_queue']);
	assert.equal(out.wp_cron_hooks, 'action_scheduler_run_queue');
});

test('fixed: the runner never runs, and the slot goes to the next due event', () => {
	const { out, spy } = run({ code: render(1, 1), crons: cron('action_scheduler_run_queue', 'jetpack_clean_nonces') });
	assert.equal(spy.runner, 0, 'the queue runner did not run');
	assert.deepEqual(spy.ran, ['jetpack_clean_nonces']);
	assert.equal(out.wp_cron_events, 1);
	assert.equal(out.wp_cron_hooks, 'jetpack_clean_nonces');
	assert.equal(out.wp_cron_skipped, 'action_scheduler_run_queue');
	assert.equal(out.wp_cron_due, 'jetpack_clean_nonces', 'the due hooks other than run_queue are reported');
	assert.ok(!spy.unscheduled.includes('action_scheduler_run_queue'), 'run_queue is not unscheduled');
	assert.ok(spy.unscheduled.includes('jetpack_clean_nonces') && spy.rescheduled.includes('jetpack_clean_nonces'), 'the event that ran is rescheduled as before');
});

test('fixed: the bounded Action Scheduler loop still runs its actions, and the backlog is reported', () => {
	const { out, spy } = run({ code: render(2, 1), crons: cron('action_scheduler_run_queue'), pending: 900, due: 850 });
	assert.deepEqual(spy.processed, [12, 11], 'CRON_AS_ACTIONS actions processed by the bounded loop, newest first (#1143)');
	assert.equal(out.as_actions, 2);
	assert.equal(out.as_pending, 900);
	assert.equal(out.as_due, 850);
	assert.equal(spy.runner, 0);
});

test('#1120: the Worker stops the leg after the first action (budget), and the leg says why', () => {
	const { out, spy } = run({ code: render(3, 1), crons: cron('action_scheduler_run_queue'), pending: 900, due: 850, more: 'budget' });
	assert.deepEqual(spy.processed, [13], 'the first action (the newest, #1143) always runs; the second asked and was told to stop');
	assert.equal(out.as_actions, 1);
	assert.equal(out.as_stop, 'budget');
});

test('#1120: with no bridge to the Worker, the leg runs one action (fails closed to the bound before #1120)', () => {
	const { out, spy } = run({ code: render(3, 1), crons: cron('action_scheduler_run_queue'), pending: 900, due: 850, noBridge: true });
	assert.deepEqual(spy.processed, [13], 'one action, the newest (#1143)');
	assert.equal(out.as_stop, 'stop');
});

test('#1143: the email claim is run NEWEST first, so a budget-stopped leg runs the newest email, not the oldest of the claim', () => {
	// AS returns the claimed ids oldest first; the leg's budget stops after one (STUB_MORE budget). strummer on cf759hx:
	// each leg ran the oldest of the newest 50 and walked backwards through a load backlog, never reaching a new order.
	const { out, spy } = run({ code: render(3, 1), crons: cron('action_scheduler_run_queue'), pending: 900, due: 850, more: 'budget' });
	assert.equal(out.as_pass, 'emails', 'the claim pass (stake_claim), the path the backlog took on MySQL');
	assert.deepEqual(spy.processed, [13], 'the newest claimed email ran first');
	assert.equal(out.as_stop, 'budget');
});

test('#1143 review: newest first alone is LIFO, so the oldest due email gets a slot each leg (second): both ends move', () => {
	// A backlog whose oldest due email (5) is not in the claim (the claim holds the newest), and a budget that allows two
	// actions: the leg sends the newest (13) and the oldest (5). Without the slot, the oldest could wait forever under a
	// steady arrival of new orders.
	const { out, spy } = run({ code: render(3, 1), crons: cron('action_scheduler_run_queue'), pending: 900, due: 850, moreSeq: '1', oldest: 5 });
	assert.equal(out.as_pass, 'emails');
	assert.deepEqual(spy.processed, [13, 5], 'the newest, then the oldest due');
	assert.equal(out.as_stop, 'budget');
	const all = run({ code: render(3, 1), crons: cron('action_scheduler_run_queue'), pending: 900, due: 850, oldest: 5 });
	assert.deepEqual(all.spy.processed, [13, 5, 12, 11], 'with room for all: the oldest second, then the rest newest first');
	assert.equal(all.spy.claimed_oldest, true, 'the oldest is CLAIMED for this leg before it runs (atomic, claim_id = 0)');
	const taken = run({ code: render(3, 1), crons: cron('action_scheduler_run_queue'), pending: 900, due: 850, oldest: 5, oldestTaken: true });
	assert.deepEqual(taken.spy.processed, [13, 12, 11], 'another runner (an operator /_runcron) holds it: this leg does not run it');
	const none = run({ code: render(3, 1), crons: cron('action_scheduler_run_queue'), pending: 900, due: 850 });
	assert.deepEqual(none.spy.processed, [13, 12, 11], 'no older due email outside the claim: unchanged');
});

test('#1120: when the Worker allows it, the leg runs every claimed action and reports no stop', () => {
	const { out, spy } = run({ code: render(3, 1), crons: cron('action_scheduler_run_queue'), pending: 900, due: 850 });
	assert.deepEqual(spy.processed, [13, 12, 11], 'newest first (#1143)');
	assert.equal(out.as_stop, null);
});

test('fixed: with only run_queue due, the tick runs no WP-Cron event and no runner', () => {
	const { out, spy } = run({ code: render(1, 1), crons: cron('action_scheduler_run_queue') });
	assert.equal(out.wp_cron_events, 0);
	assert.equal(spy.runner, 0);
	assert.deepEqual(spy.ran, []);
	assert.equal(out.wp_cron_due, '', 'nothing else was due, so running none starves nothing');
});

test('fixed: with CRON_WP_EVENTS 2, both other due events run and run_queue is still skipped', () => {
	const { out, spy } = run({ code: render(1, 2), crons: cron('action_scheduler_run_queue', 'jetpack_clean_nonces', 'wc_admin_process_orders_milestone') });
	assert.deepEqual(spy.ran, ['jetpack_clean_nonces', 'wc_admin_process_orders_milestone']);
	assert.equal(spy.runner, 0);
	assert.equal(out.wp_cron_events, 2);
});
