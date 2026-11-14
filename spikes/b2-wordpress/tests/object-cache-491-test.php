<?php
// php spikes/b2-wordpress/tests/object-cache-491-test.php   (#491)
//
// Two isolates, one shared cross-request store that LAGS (as the in-isolate Map of another isolate
// and the eventually consistent KV both can): isolate X writes a new alloptions; the shared store
// still answers isolate Y with the OLD blob for a while. Measured on wp-a-lean (Joan, #491 run 3):
// alloptions stale in 7 of 20 reads right after a write, and a form saved from such a page writes
// the old values back. With the fix, no options op reaches the shared store, so Y's read is a miss
// (WordPress then reads MySQL) and cannot be stale. The control group `terms` still goes through.
//   php object-cache-491-test.php [path/to/object-cache-js.php]

$GLOBALS['store'] = array();   // the shared, lagging cross-request store (pkey => value as JSON)
$GLOBALS['ops']   = array();
function post_message_to_js( $json ) {
	$m  = json_decode( $json, true );
	$op = isset( $m['oc'] ) ? $m['oc'] : array();
	$GLOBALS['ops'][] = $op;
	if ( 'get' === $op['op'] ) {
		$out = array();
		foreach ( $op['k'] as $k ) {
			$out[] = array_key_exists( $k, $GLOBALS['store'] ) ? $GLOBALS['store'][ $k ] : null;
		}
		return json_encode( array( 'v' => $out ) );
	}
	if ( 'set' === $op['op'] ) {
		return json_encode( array( 'ok' => true ) ); // the write is in flight: the store LAGS and keeps the old value
	}
	return json_encode( array( 'ok' => true, 'n' => 0 ) );
}
function is_multisite() { return false; }
function get_current_blog_id() { return 1; }
function wp_suspend_cache_addition() { return false; }
define( 'JS_OBJECT_CACHE_PERSIST_GROUPS', 'options,terms,theme_json' ); // as env.a-paid-lean set it before #491
define( 'JS_OBJECT_CACHE_TTL', 10 );
require isset( $argv[1] ) ? $argv[1] : __DIR__ . '/../php/object-cache-js.php';

$fail = 0;
function check( $label, $cond ) {
	global $fail;
	echo ( $cond ? 'ok   ' : 'FAIL ' ) . $label . "\n";
	$fail += $cond ? 0 : 1;
}

// Seed the shared store with the OLD values, as a cross-request cache that has not caught up.
$x = new JS_Object_Cache();                     // isolate X
$GLOBALS['ops'] = array();
$x->set( 'probe', 'seed', 'terms' );
$seed = $GLOBALS['ops'];
$terms_key = $seed ? $seed[0]['k'] : null;
// The store's key format comes from the drop-in itself (group NUL key): build the options key the same way.
$opt_key = 'options' . "\0" . 'alloptions';
// The drop-in stores base64(serialize(value)) (object-cache-js.php set()).
$GLOBALS['store'][ $opt_key ]   = base64_encode( serialize( array( 'blogdescription' => 'OLD' ) ) );
$GLOBALS['store'][ $terms_key ] = base64_encode( serialize( 'OLD' ) );

// Isolate X writes the NEW alloptions (update_option did its SQL; the cache write is in flight).
$GLOBALS['ops'] = array();
$x->set( 'alloptions', array( 'blogdescription' => 'NEW' ), 'options' );
$x_options_ops = count( $GLOBALS['ops'] );

// Isolate Y, a fresh request in another isolate, reads alloptions within the window.
$y = new JS_Object_Cache();
$GLOBALS['ops'] = array();
$found = null;
$got = $y->get( 'alloptions', 'options', false, $found );
$y_options_ops = count( $GLOBALS['ops'] );

check( '#491: isolate X\'s options write sends nothing to the shared store', 0 === $x_options_ops );
check( '#491: isolate Y\'s options read does not consult the shared store', 0 === $y_options_ops );
check( '#491: isolate Y gets a MISS (WordPress then reads MySQL), never the stale OLD blob', false === $got && false === $found );

// Control: an allowlisted group still goes through the shared store (the instrument can see a positive).
$GLOBALS['ops'] = array();
$tv = $y->get( 'probe', 'terms' );
check( 'control: a terms read does consult the shared store', 1 === count( $GLOBALS['ops'] ) );
check( 'control: and gets the lagging store\'s value (so a stale options value WOULD be seen without the fix)', 'OLD' === $tv );

echo $fail ? "$fail failing check(s)\n" : "all checks pass\n";
exit( $fail ? 1 : 0 );
