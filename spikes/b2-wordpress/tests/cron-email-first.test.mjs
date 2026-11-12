// The cron tick claims a new order email before the backlog (#357): the REAL runCron script from
// index.js, run by the php CLI against a stub Action Scheduler store that applies the claim rules:
// only due pending actions, the group argument of stake_claim (a missing group throws, as
// ActionScheduler_DBStore does), and the action_scheduler_claim_actions_order_by filter (default
// priority, then scheduled date oldest first, then id).
// - The reproduction: with the email pass taken out of the rendered script, a new order email waits
//   behind every older due action. On the sample store that was about 3492 actions, about 85 h at
//   the measured 41 an hour (fdprobe1112j, 2026-11-12).
// - The fix: pass 1 claims the woocommerce-emails group newest first, and the order filter is gone
//   again before pass 2; pass 2 (everything, oldest first) runs only when pass 1 claimed nothing.
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
const render = (actions) => new Function('actions', 'wpEvents', 'cleanDue', 'return `' + tpl + '`;')(actions, 0, false);

// The email pass, from its first statement to the end of the pass 2 block.
const PASS_START = "$as_pass = 'emails'; $claim = null;";
const PASS_END_MARK = "$as_pass = 'all';";
function withoutEmailPass(code, actions) {
	const a = code.indexOf(PASS_START);
	const m = code.indexOf(PASS_END_MARK, a);
	const b = code.indexOf('}', code.indexOf('stake_claim(', m)) + 1;
	assert.ok(a > 0 && m > a && b > m, 'the email pass is in the rendered script');
	return code.slice(0, a) + '$claim = $as_store->stake_claim( ' + actions + ' );' + code.slice(b);
}

const STUBS = `<?php
$GLOBALS['spy'] = array( 'processed' => array(), 'claims' => array(), 'released' => 0 );
$GLOBALS['stub_filters'] = array();
function add_action( $h, $f ) {}
function remove_all_actions( $h ) {}
function add_filter( $h, $f ) { $GLOBALS['stub_filters'][ $h ][] = $f; }
function remove_filter( $h, $f ) { foreach ( isset( $GLOBALS['stub_filters'][ $h ] ) ? $GLOBALS['stub_filters'][ $h ] : array() as $i => $g ) { if ( $g === $f ) { unset( $GLOBALS['stub_filters'][ $h ][ $i ] ); } } }
function apply_filters( $h, $v ) { foreach ( isset( $GLOBALS['stub_filters'][ $h ] ) ? $GLOBALS['stub_filters'][ $h ] : array() as $f ) { $v = $f( $v ); } return $v; }
function do_action_ref_array( $h, $args ) {}
function wp_cache_flush_runtime() {}
function _get_cron_array() { return array(); }
class Stub_DB { public $prefix = 'wp_'; function query( $q ) { return 0; } function get_var( $q ) { return 0; } }
$GLOBALS['wpdb'] = new Stub_DB();
$GLOBALS['stub_actions'] = json_decode( getenv( 'STUB_ACTIONS' ), true );
class Stub_Date { public $d; function __construct( $d ) { $this->d = $d; } function format( $f ) { return $this->d; } }
class Stub_Schedule { public $d; function __construct( $d ) { $this->d = $d; } function get_date() { return new Stub_Date( $this->d ); } }
class Stub_Action { public $h; public $d; function __construct( $h, $d = '' ) { $this->h = $h; $this->d = $d; } function get_hook() { return $this->h; } function get_schedule() { return new Stub_Schedule( $this->d ); } }
class Stub_Claim { public $ids; function __construct( $ids ) { $this->ids = $ids; } function get_actions() { return $this->ids; } }
class Stub_Store {
	// ActionScheduler_DBStore::claim_actions STORES a group it is given (set_claim_filter) and reuses
	// it when a later claim on the same store has no group. The stub does the same.
	public $claim_filters = array( 'group' => '', 'hooks' => '', 'exclude-groups' => '' );
	function set_claim_filter( $k, $v ) { if ( isset( $this->claim_filters[ $k ] ) ) { $this->claim_filters[ $k ] = $v; } }
	function stake_claim( $n = 10, $before = null, $hooks = array(), $group = '' ) {
		if ( '' !== $group ) { $this->set_claim_filter( 'group', $group ); } else { $group = $this->claim_filters['group']; }
		$now = gmdate( 'Y-m-d H:i:s' );
		$all = $GLOBALS['stub_actions'];
		if ( '' !== $group && ! in_array( $group, array_column( $all, 'group' ), true ) ) { throw new InvalidArgumentException( 'The group "' . $group . '" does not exist.' ); }
		$rows = array_values( array_filter( $all, function ( $a ) use ( $group, $now ) { return $a['date'] <= $now && ( '' === $group || $a['group'] === $group ); } ) );
		$order = apply_filters( 'action_scheduler_claim_actions_order_by', 'ORDER BY priority ASC, attempts ASC, scheduled_date_gmt ASC, action_id ASC', 0, $hooks );
		$desc = false !== strpos( $order, 'scheduled_date_gmt DESC' );
		usort( $rows, function ( $x, $y ) use ( $desc ) {
			if ( $x['priority'] !== $y['priority'] ) { return $x['priority'] - $y['priority']; }
			$c = strcmp( $x['date'], $y['date'] ) ?: ( $x['id'] - $y['id'] );
			return $desc ? -$c : $c;
		} );
		$ids = array_slice( array_column( $rows, 'id' ), 0, $n );
		$GLOBALS['spy']['claims'][] = array( 'group' => $group, 'order' => $order, 'ids' => $ids );
		return new Stub_Claim( $ids );
	}
	function fetch_action( $id ) { foreach ( $GLOBALS['stub_actions'] as $a ) { if ( $a['id'] === $id ) { return new Stub_Action( $a['hook'], $a['date'] ); } } return null; }
	function release_claim( $c ) { $GLOBALS['spy']['released']++; }
}
class Stub_Runner { function process_action( $id, $ctx ) { $GLOBALS['spy']['processed'][] = $id; } }
class ActionScheduler { static $s; static function store() { return self::$s ? self::$s : ( self::$s = new Stub_Store() ); } static function runner() { return new Stub_Runner(); } }
class ActionScheduler_QueueCleaner { function __construct( $s ) {} function reset_timeouts() {} function mark_failures() {} }
register_shutdown_function( function () { $GLOBALS['spy']['filters_left'] = count( isset( $GLOBALS['stub_filters']['action_scheduler_claim_actions_order_by'] ) ? $GLOBALS['stub_filters']['action_scheduler_claim_actions_order_by'] : array() ); fwrite( STDERR, json_encode( $GLOBALS['spy'] ) ); } );
`;

function run(code, actions) {
	const d = mkdtempSync(join(tmpdir(), 'cron-email-first-'));
	try {
		writeFileSync(join(d, 'stubs.php'), STUBS);
		writeFileSync(join(d, 'cron.php'), code.replace("require '/wordpress/wp-load.php';", "require '" + join(d, 'stubs.php') + "';"));
		const r = spawnSync('php', ['-n', join(d, 'cron.php')], { env: { ...process.env, STUB_ACTIONS: JSON.stringify(actions) }, encoding: 'utf8' });
		assert.equal(r.status, 0, r.stderr + r.stdout);
		return { out: JSON.parse(r.stdout.slice(r.stdout.lastIndexOf('{'))), spy: JSON.parse(r.stderr) };
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
}

const ts = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString().slice(0, 19).replace('T', ' ');
const LOOKUP = 'woocommerce_run_product_attribute_lookup_update_callback';
const EMAIL = 'woocommerce_send_queued_transactional_email';
const act = (id, hook, group, minutesAgo, priority = 10) => ({ id, hook, group, date: ts(minutesAgo), priority });
// The sample store's shape: old lookups and old emails, mixed by date, days ago; then a new order email.
const BACKLOG = [
	act(1, LOOKUP, 'woocommerce-db-updates', 5000),
	act(2, EMAIL, 'woocommerce-emails', 4990),
	act(3, LOOKUP, 'woocommerce-db-updates', 4980),
	act(4, EMAIL, 'woocommerce-emails', 4970),
	act(5, LOOKUP, 'woocommerce-db-updates', 4960),
];
const NEW_EMAIL = act(900, EMAIL, 'woocommerce-emails', 0.5);
const FUTURE_EMAIL = act(901, EMAIL, 'woocommerce-emails', -60); // not due yet

test('reproduction: without the email pass, a new order email waits behind the older backlog', () => {
	const { out, spy } = run(withoutEmailPass(render(1), 1), [...BACKLOG, NEW_EMAIL]);
	assert.deepEqual(spy.processed, [1], 'the oldest action (a lookup) is claimed, not the new email');
	assert.equal(out.as_hooks, LOOKUP + ':1');
});

test('fixed: the new order email is claimed first, from the email group, newest first', () => {
	const { out, spy } = run(render(1), [...BACKLOG, NEW_EMAIL, FUTURE_EMAIL]);
	assert.deepEqual(spy.processed, [900]);
	assert.equal(out.as_pass, 'emails');
	assert.equal(out.as_hooks, EMAIL + ':1');
	assert.equal(out.as_dates, NEW_EMAIL.date, 'the tick reports the scheduled date of the email it ran');
	assert.equal(spy.claims.length, 1, 'pass 2 did not run');
	assert.equal(spy.claims[0].group, 'woocommerce-emails');
	assert.match(spy.claims[0].order, /scheduled_date_gmt DESC/);
	assert.equal(spy.filters_left, 0, 'the order filter is removed after pass 1');
});

test('fixed: with no new email, the old emails still go first, the newest of them first', () => {
	const { spy } = run(render(1), BACKLOG);
	assert.deepEqual(spy.processed, [4]);
});

test('fixed: no email due, so pass 1 is empty, released, and pass 2 claims the oldest with the default order', () => {
	const { out, spy } = run(render(1), [act(1, LOOKUP, 'woocommerce-db-updates', 5000), act(3, LOOKUP, 'woocommerce-db-updates', 4980), FUTURE_EMAIL]);
	assert.deepEqual(spy.processed, [1]);
	assert.equal(out.as_pass, 'all');
	assert.equal(spy.claims.length, 2);
	assert.deepEqual(spy.claims[0].ids, []);
	assert.equal(spy.released, 2, 'the empty pass 1 claim and the pass 2 claim are both released');
	assert.doesNotMatch(spy.claims[1].order, /DESC/, 'pass 2 uses the default, oldest first');
	assert.equal(spy.claims[1].group, '', 'pass 2 does not inherit the group pass 1 stored on the store (live: a tick claimed nothing)');
	assert.equal(spy.filters_left, 0);
});

test('fixed: a store with no woocommerce-emails group yet (the claim throws) falls through to pass 2', () => {
	const { out, spy } = run(render(1), [act(1, LOOKUP, 'woocommerce-db-updates', 5000)]);
	assert.deepEqual(spy.processed, [1]);
	assert.equal(out.as_pass, 'all');
	assert.equal(spy.filters_left, 0, 'the filter is removed after the throw too');
});

test('fixed: CRON_AS_ACTIONS 2 with one due email claims that email only; pass 2 does not top up', () => {
	const { out, spy } = run(render(2), [act(1, LOOKUP, 'woocommerce-db-updates', 5000), NEW_EMAIL]);
	assert.deepEqual(spy.processed, [900]);
	assert.equal(out.as_actions, 1);
});
