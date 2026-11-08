<?php
// php spikes/b2-wordpress/tests/object-cache-isolated-test.php
//
// The approach-A object cache (issue #218). On A there are many Worker isolates,
// each with its own Map, all writing the shared MySQL, so a write in one isolate
// never purges another's Map. The drop-in therefore persists ONLY an allowlist of
// cross-isolate-safe groups; everything else, above all the WooCommerce correctness
// groups, stays per request. This proves that posture with a stubbed bridge (no DB):
// which groups reach the persistent store, the bounded TTL, the salted-group
// override, and the spike-gated force-off. b-dosql keeps its posture (persist_allow
// stays null) and is covered by its own live tests.

$GLOBALS['oc_ops'] = array();
// Stub the php-wasm bridge: record each object-cache op, answer gets as all-miss.
function post_message_to_js( $json ) {
	$m  = json_decode( $json, true );
	$op = isset( $m['oc'] ) ? $m['oc'] : array();
	$GLOBALS['oc_ops'][] = $op;
	if ( isset( $op['op'] ) && 'get' === $op['op'] ) {
		return json_encode( array( 'v' => array_fill( 0, count( $op['k'] ), null ) ) );
	}
	return json_encode( array( 'ok' => true, 'n' => 0 ) );
}
function is_multisite() { return false; }
function get_current_blog_id() { return 1; }
function wp_suspend_cache_addition() { return false; }

define( 'JS_OBJECT_CACHE_PERSIST_GROUPS', 'options,terms' );
define( 'JS_OBJECT_CACHE_TTL', 7 );

require __DIR__ . '/../php/object-cache-js.php';

$fail = 0;
function check( $label, $cond ) {
	global $fail;
	if ( $cond ) { echo "ok   $label\n"; return; }
	$fail++; echo "FAIL $label\n";
}
function reset_ops() { $GLOBALS['oc_ops'] = array(); }
function ops_of( $type ) {
	return array_values( array_filter( $GLOBALS['oc_ops'], function ( $o ) use ( $type ) {
		return isset( $o['op'] ) && $o['op'] === $type;
	} ) );
}

$oc = new JS_Object_Cache();

// 1. An allowlisted group is persistent, and a zero-expire set takes the bounded TTL.
reset_ops();
$oc->set( 'a', 'v1', 'options' );
$sets = ops_of( 'set' );
check( 'an allowlisted group (options) reaches the persistent store', 1 === count( $sets ) );
check( 'a zero-expire persistent set takes the bounded TTL (7)', $sets && 7 === $sets[0]['ttl'] );

// 2. THE CORRECTNESS RULE: a WooCommerce group is NEVER persisted on approach A.
reset_ops();
$oc->set( 'sess', 'v2', 'woocommerce_sessions' );
check( 'a WooCommerce group set never reaches the persistent store', 0 === count( ops_of( 'set' ) ) );
reset_ops();
$oc->get( 'missing', 'woocommerce_sessions' );
check( 'a WooCommerce group get never reaches the persistent store', 0 === count( ops_of( 'get' ) ) );

// 3. An allowlisted group read (not in the per-request array) does reach the store.
reset_ops();
$oc->get( 'b', 'options' );
check( 'an allowlisted group get reaches the persistent store', 1 === count( ops_of( 'get' ) ) );

// 4. A salted group persists even when it is not on the allowlist, keyed by the salt.
$oc->set_group_salt( 'woocommerce_cart', 'deadbeef' );
reset_ops();
$oc->set( 'x', 'v3', 'woocommerce_cart' );
$salted = ops_of( 'set' );
check( 'a salted non-allowlisted group becomes persistent', 1 === count( $salted ) );
check( 'the salted key carries the salt', $salted && false !== strpos( $salted[0]['k'], 'deadbeef' ) );

// 5. The spike-gated force-off makes every group per-request on this binary.
$_SERVER['HTTP_X_OC_OFF'] = '1';
$off = new JS_Object_Cache();
reset_ops();
$off->set( 'a', 'v', 'options' );
check( 'x-oc-off forces an allowlisted group off the persistent store', 0 === count( ops_of( 'set' ) ) );
unset( $_SERVER['HTTP_X_OC_OFF'] );

echo $fail ? "\n$fail failing check(s)\n" : "\nall checks pass\n";
exit( $fail ? 1 : 0 );
