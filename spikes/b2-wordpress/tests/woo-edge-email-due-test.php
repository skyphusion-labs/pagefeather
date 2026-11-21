<?php
// php spikes/b2-wordpress/tests/woo-edge-email-due-test.php (#1215)
// #969's trigger: a request that queues a WooCommerce email tells the Worker (emailDue), which wakes the cron alarm.
// It listened on action_scheduler_stored_action_instance, which Action Scheduler applies when it LOADS an action from
// the store (ActionScheduler_ActionFactory::get_stored_action, from DBStore::fetch_action), never when it stores one.
// A checkout stores the email action and never loads it, so emailDue was never sent (measured locally on a-shape-local:
// an order, 0 emailDue messages). WooCommerce queues it with WC()->queue()->add(), which is
// as_schedule_single_action( time(), ... ): its pre_as_schedule_single_action filter runs at enqueue, with the hook.
// Minimal WordPress stubs; the real file is loaded.
$fail = 0;
function check( $label, $got, $want ) {
	global $fail;
	if ( $got === $want ) { echo "ok   $label\n"; return; }
	$fail++; echo "FAIL $label\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
}
$GLOBALS['hooks'] = array(); $GLOBALS['sent'] = array();
function add_filter( $h, $cb, $p = 10, $n = 1 ) { $GLOBALS['hooks'][ $h ][] = array( $cb, $n ); }
function add_action( $h, $cb, $p = 10, $n = 1 ) { $GLOBALS['hooks'][ $h ][] = array( $cb, $n ); }
function post_message_to_js( $j ) { $GLOBALS['sent'][] = $j; return '1'; }
function wp_json_encode( $v ) { return json_encode( $v ); }
function fire( $h, ...$a ) { $out = $a[0] ?? null; foreach ( $GLOBALS['hooks'][ $h ] ?? array() as $x ) { $out = call_user_func_array( $x[0], array_slice( array_merge( array( $out ), array_slice( $a, 1 ) ), 0, $x[1] ) ); } return $out; }
function shutdown() { foreach ( $GLOBALS['hooks']['shutdown'] ?? array() as $x ) { call_user_func( $x[0] ); } }
require __DIR__ . '/../php/woo-edge.php';
$E = 'woocommerce_send_queued_transactional_email';
$due = function () { return count( array_filter( $GLOBALS['sent'], function ( $j ) { return false !== strpos( $j, '"emailDue"' ); } ) ); };
$reset = function () { $GLOBALS['sent'] = array(); unset( $GLOBALS['skyphusion_email_action_stored'] ); };

check( 'the trigger is NOT the load-time filter (it never fires when an action is stored)', isset( $GLOBALS['hooks']['action_scheduler_stored_action_instance'] ), false );
check( 'it listens at enqueue: pre_as_schedule_single_action (WC()->queue()->add) and pre_as_enqueue_async_action', array( isset( $GLOBALS['hooks']['pre_as_schedule_single_action'] ), isset( $GLOBALS['hooks']['pre_as_enqueue_async_action'] ) ), array( true, true ) );

$reset();
$r = fire( 'pre_as_schedule_single_action', null, time(), $E, array( 'x' ), 'woocommerce-emails', 10, false );
check( 'a queued email due now: the filter passes null through (Action Scheduler stores it)', $r, null );
shutdown();
check( '  and at shutdown the Worker is told once (emailDue)', $due(), 1 );

$reset();
fire( 'pre_as_schedule_single_action', null, time(), $E, array(), 'woocommerce-emails', 10, false );
fire( 'pre_as_schedule_single_action', null, time(), $E, array(), 'woocommerce-emails', 10, false );
shutdown();
check( 'two queued emails: told once', $due(), 1 );

$reset();
fire( 'pre_as_enqueue_async_action', null, $E, array(), 'woocommerce-emails', 10, false );
shutdown();
check( 'an async enqueue of the email hook: told', $due(), 1 );

$reset();
fire( 'pre_as_schedule_single_action', null, time(), 'woocommerce_cleanup_sessions', array(), '', 10, false );
shutdown();
check( 'another hook: not told', $due(), 0 );

$reset();
$r = fire( 'pre_as_schedule_single_action', 77, time(), $E, array(), 'woocommerce-emails', 10, false );
shutdown();
check( 'another filter already short-circuited the enqueue: its answer stands, not told', array( $r, $due() ), array( 77, 0 ) );

$reset();
fire( 'pre_as_schedule_single_action', null, time() + 3600, $E, array(), 'woocommerce-emails', 10, false );
shutdown();
check( 'an email scheduled an hour ahead: not told (nothing is due)', $due(), 0 );

$reset();
shutdown();
check( 'nothing queued: not told', $due(), 0 );
echo $fail ? "$fail FAILED\n" : "ALL PASS\n";
exit( $fail ? 1 : 0 );
