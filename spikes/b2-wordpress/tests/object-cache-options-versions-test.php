<?php
// php spikes/b2-wordpress/tests/object-cache-options-versions-test.php   (#296 (2), options half)
//
// `options` back in approach A's cross-isolate cache, EXACT: with JS_OBJECT_CACHE_VERSIONED naming
// options, the group persists under its version from <prefix>skyph_cache_versions (read ONCE per
// request, used as the group salt). A write to wp_options (not a transient) bumps the version in the
// same statement (an AFTER trigger, cache-versions.mjs). The shared store LAGS, as #491 measured (the
// isolate Map of another isolate, or the eventually consistent KV): a write is in flight and the
// store keeps answering the OLD value. Each "request" is a new JS_Object_Cache.
//   php object-cache-options-versions-test.php [path/to/object-cache-js.php]

$GLOBALS['store'] = array();   // the shared, lagging cross-request store (pkey => value)
$GLOBALS['ops']   = array();
$GLOBALS['lag']   = false;      // true: a set is in flight and the store keeps the old value
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
	if ( 'set' === $op['op'] && ! $GLOBALS['lag'] ) {
		$GLOBALS['store'][ $op['k'] ] = $op['v'];
	}
	return json_encode( array( 'ok' => true, 'n' => 0 ) );
}
function is_multisite() { return false; }
function get_current_blog_id() { return 1; }
function wp_suspend_cache_addition() { return false; }
if ( ! defined( 'ARRAY_N' ) ) {
	define( 'ARRAY_N', 'ARRAY_N' );
}
class Fake_WPDB {
	public $prefix = 'wp_';
	public $v = 0;            // the options version row
	public $table = true;     // the versions table exists
	public $reads = 0;
	public function suppress_errors( $on = true ) { return false; }
	public function get_results( $sql, $mode = null ) {
		if ( false !== strpos( $sql, 'skyph_cache_versions' ) ) {
			++$this->reads;
			return $this->table ? array( array( 'options', (string) $this->v ) ) : null;
		}
		return array();
	}
}
$GLOBALS['wpdb'] = new Fake_WPDB();
define( 'JS_OBJECT_CACHE_PERSIST_GROUPS', 'theme_json' ); // today's approach A (env.a-paid-lean)
define( 'JS_OBJECT_CACHE_TTL', 10 );
define( 'JS_OBJECT_CACHE_VERSIONED', 'options' );
// #1199: transients are rows in wp_options now (the drop-in's skyphusion_transient_* functions; these replace its $wpdb
// ones with an in-memory table, as tests/object-cache-transients-test.php does).
$GLOBALS['transient_rows'] = array();
function skyphusion_transient_rows( array $names ) { $o = array(); foreach ( $names as $n ) { if ( array_key_exists( $n, $GLOBALS['transient_rows'] ) ) { $o[ $n ] = $GLOBALS['transient_rows'][ $n ]; } } return $o; }
function skyphusion_transient_put( $n, $v ) { $GLOBALS['transient_rows'][ $n ] = $v; return true; }
function skyphusion_transient_delete( array $names ) { $k = 0; foreach ( $names as $n ) { if ( array_key_exists( $n, $GLOBALS['transient_rows'] ) ) { unset( $GLOBALS['transient_rows'][ $n ] ); ++$k; } } return $k; }
require isset( $argv[1] ) ? $argv[1] : __DIR__ . '/../php/object-cache-js.php';

$fail = 0;
function check( $label, $cond ) {
	global $fail;
	echo ( $cond ? 'ok   ' : 'FAIL ' ) . $label . "\n";
	$fail += $cond ? 0 : 1;
}
function opts_ops() {
	return count( array_filter( $GLOBALS['ops'], function ( $op ) {
		foreach ( (array) ( isset( $op['k'] ) ? $op['k'] : array() ) as $k ) {
			if ( 0 === strpos( (string) $k, "options\0" ) ) {
				return true;
			}
		}
		return false;
	} ) );
}
$wpdb = $GLOBALS['wpdb'];

// Request 1, isolate X, version 0: a miss, then WordPress loads alloptions from MySQL and caches it.
$x = new JS_Object_Cache();
$found = null;
$x->get( 'alloptions', 'options', false, $found );
$x->set( 'alloptions', array( 'blogdescription' => 'A' ), 'options' );
check( 'request 1: one versions read', 1 === $wpdb->reads );
check( 'request 1: the options write reaches the shared store (options persist when versioned)', opts_ops() >= 1 );

// Request 2, isolate Y, still version 0: a HIT across isolates. Today (#491) this is always a miss.
$GLOBALS['ops'] = array();
$y  = new JS_Object_Cache();
$hit = $y->get( 'alloptions', 'options', false, $found );
check( 'request 2: alloptions is a hit from the shared store', is_array( $hit ) && 'A' === $hit['blogdescription'] && true === $found );
check( 'request 2: one versions read for the request (total 2)', 2 === $wpdb->reads );
$y->get( 'alloptions', 'options', false, $found );
$y->get( 'siteurl', 'options', false, $found );
check( 'request 2: no second versions read in the same request', 2 === $wpdb->reads );

// A write to wp_options in isolate X: the trigger bumps the version with the data; the new cache
// value is IN FLIGHT (the store lags and still holds the old key).
$wpdb->v          = 1;
$GLOBALS['lag']   = true;
$x->set( 'alloptions', array( 'blogdescription' => 'B' ), 'options' );

// Request 3, isolate Y, a new request: version 1. The old value is still in the store under the old
// key, and the new one has not landed. Y must MISS (WordPress reads MySQL), never serve 'A'.
$GLOBALS['ops'] = array();
$y3 = new JS_Object_Cache();
$got = $y3->get( 'alloptions', 'options', false, $found );
check( 'request 3: after the write, a miss: never the stale A (the #491 defect)', false === $got && false === $found );
check( 'request 3: the read asked the store under the NEW key only', opts_ops() === 1 && false === strpos( json_encode( $GLOBALS['ops'] ), json_encode( "options\0v0\0" ) ) );

// Request 4: the new value lands; it is a hit on version 1.
$GLOBALS['lag'] = false;
$y3->set( 'alloptions', array( 'blogdescription' => 'B' ), 'options' );
$y4  = new JS_Object_Cache();
$got = $y4->get( 'alloptions', 'options', false, $found );
check( 'request 4: a hit on the new version, the new value', is_array( $got ) && 'B' === $got['blogdescription'] );

// No versions table (not installed, or a provider without triggers): the #491 posture holds,
// options never touch the shared store.
$wpdb->table    = false;
$GLOBALS['ops'] = array();
$z  = new JS_Object_Cache();
$zg = $z->get( 'alloptions', 'options', false, $found );
$z->set( 'alloptions', array( 'blogdescription' => 'C' ), 'options' );
check( 'no table: options send nothing to the shared store (#491 holds)', 0 === opts_ops() && false === $zg );

// Control: transients are NOT versioned and never go to the shared store. #1199: they are durable rows in wp_options
// (before #1199 they stayed per request on approach A, which lost them).
$wpdb->table    = true;
$GLOBALS['ops'] = array();
$t = new JS_Object_Cache();
$t->set( 'wc_attribute_taxonomies', array( 1 ), 'transient' );
check( 'control: a transient makes no shared-store op', 0 === count( $GLOBALS['ops'] ) );
check( '#1199: and it is a row in wp_options (_transient_wc_attribute_taxonomies)', array( 1 ) === ( isset( $GLOBALS['transient_rows']['_transient_wc_attribute_taxonomies'] ) ? $GLOBALS['transient_rows']['_transient_wc_attribute_taxonomies'] : null ) );

// ---- The options misses (#643 live check, 2026-11-15): 49 options gets per request, 0 L1 hits, 39 KV misses, but
// only 0.84 options sets per request. WordPress core's wp_prime_option_caches() asks the cache for every listed option
// by key (wp_cache_get_multiple), also the ones that live in alloptions or notoptions, and never writes those keys
// alone, so they miss forever; with options persistent, each such miss was a KV read. A key this request's alloptions
// or notoptions already holds is answered as a miss locally, with no bridge call (core ignores that value anyway).
$wpdb->table = true;
$GLOBALS['ops'] = array();
$q = new JS_Object_Cache();
$q->set( 'alloptions', array( 'blogname' => 'X', 'woocommerce_cod_settings' => 'a:0:{}' ), 'options' );
$q->set( 'notoptions', array( 'no_such_option' => true ), 'options' );
$GLOBALS['ops'] = array();
$got = $q->get_multiple( array( 'blogname', 'woocommerce_cod_settings', 'no_such_option' ), 'options' );
check( 'keys in alloptions or notoptions: answered as misses, as before', false === $got['blogname'] && false === $got['woocommerce_cod_settings'] && false === $got['no_such_option'] );
check( 'and with NO bridge call (no KV read) for them', 0 === count( array_filter( $GLOBALS['ops'], function ( $op ) { return 'get' === $op['op']; } ) ) );
$GLOBALS['ops'] = array();
$q->get( 'woocommerce_cod_settings', 'options', false, $found );
check( 'the same for a single get', 0 === count( array_filter( $GLOBALS['ops'], function ( $op ) { return 'get' === $op['op']; } ) ) && false === $found );
$GLOBALS['ops'] = array();
$q->get( 'a_real_unautoloaded_option', 'options', false, $found );
check( 'a key in neither still goes to the shared store', 1 === count( array_filter( $GLOBALS['ops'], function ( $op ) { return 'get' === $op['op']; } ) ) );

// #734: with OBJECT_CACHE_VERSIONS on and NO versions table, PHP tells JS once per request (op vmiss), so the Worker can
// log it and deploy/doctor can warn. With the table: nothing.
$vmiss = function () { return count( array_filter( $GLOBALS['ops'], function ( $op ) { return 'vmiss' === $op['op']; } ) ); };
$wpdb->table = false; $GLOBALS['ops'] = array();
$m = new JS_Object_Cache();
$m->get( 'alloptions', 'options', false, $found );
$m->get( 'blogname', 'options', false, $found );
check( '#734: no table: one vmiss for the request', 1 === $vmiss() );
$wpdb->table = true; $GLOBALS['ops'] = array();
$m2 = new JS_Object_Cache();
$m2->get( 'alloptions', 'options', false, $found );
check( '#734: the table there: no vmiss', 0 === $vmiss() );

echo $fail ? "$fail failing check(s)\n" : "all checks pass\n";
exit( $fail ? 1 : 0 );
