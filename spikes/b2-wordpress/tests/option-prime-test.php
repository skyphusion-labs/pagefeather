<?php
/**
 * #1090: php/option-prime.php. On approach A a cold isolate read about 50 not-autoloaded options one query each
 * (strummer, cf759hx: 52 single-row reads at about 24 ms on a just-booted isolate; the same isolate's next render, 0).
 * The plugin keeps the site's learned list of those names in one autoloaded option (it arrives with alloptions) and,
 * early in every request, primes them with wp_prime_option_caches (ONE IN query on a cold isolate, none on a warm one).
 * It learns a name from core's own single-row miss query, and writes the list only when it grows.
 * Run: php spikes/b2-wordpress/tests/option-prime-test.php
 */
$GLOBALS['opts'] = array(); $GLOBALS['filters'] = array(); $GLOBALS['actions'] = array(); $GLOBALS['primed'] = array(); $GLOBALS['updates'] = 0;
function get_option( $k, $d = false ) { return array_key_exists( $k, $GLOBALS['opts'] ) ? $GLOBALS['opts'][ $k ] : $d; }
function update_option( $k, $v, $autoload = null ) { $GLOBALS['opts'][ $k ] = $v; $GLOBALS['updates']++; $GLOBALS['autoload'][ $k ] = $autoload; return true; }
function add_filter( $h, $cb, $p = 10, $n = 1 ) { $GLOBALS['filters'][ $h ][] = $cb; return true; }
function add_action( $h, $cb, $p = 10, $n = 1 ) { $GLOBALS['actions'][ $h ][] = $cb; return true; }
// The prime: when PRIME_ROWS is set it ran one query (a cold isolate) that returned those rows.
function wp_prime_option_caches( $names ) {
	$GLOBALS['primed'][] = $names;
	if ( ! empty( $GLOBALS['prime_rows'] ) ) { $GLOBALS['wpdb']->num_queries++; $GLOBALS['wpdb']->last_result = $GLOBALS['prime_rows']; }
}
function maybe_serialize( $v ) { return is_array( $v ) || is_object( $v ) ? serialize( $v ) : $v; }
$GLOBALS['bridge'] = array();
function post_message_to_js( $json ) { $GLOBALS['bridge'][] = json_decode( $json, true ); return '1'; }
class Stub_DB { public $options = 'wp_options'; public $num_queries = 0; public $last_result = array(); }
$GLOBALS['wpdb'] = new Stub_DB();
function q( $sql ) { foreach ( $GLOBALS['filters']['query'] as $cb ) { $sql = $cb( $sql ); } return $sql; }
function shutdown() { foreach ( $GLOBALS['actions']['shutdown'] as $cb ) { $cb(); } }
$fail = 0;
function ok( $label, $cond ) { global $fail; echo ( $cond ? 'PASS ' : 'FAIL ' ) . $label . "\n"; if ( ! $cond ) { $fail++; } }

define( 'JS_OBJECT_CACHE_VERSIONED', 'options' );
// Request 1, a cold isolate with no list yet: nothing to prime; two misses are learned, a transient and a prime are not.
require __DIR__ . '/../php/option-prime.php';
ok( 'no list yet: nothing primed', array() === $GLOBALS['primed'] );
q( "SELECT option_value FROM wp_options WHERE option_name = 'woocommerce_task_list_hidden' LIMIT 1" );
q( "SELECT option_value FROM wp_options WHERE option_name = 'wc_feature_x' LIMIT 1" );
q( "SELECT option_value FROM wp_options WHERE option_name = '_transient_wc_count' LIMIT 1" );
q( "SELECT option_value FROM wp_options WHERE option_name = '_site_transient_update_core' LIMIT 1" );
q( "SELECT option_name, option_value FROM wp_options WHERE option_name IN ('a','b')" );
ok( 'the query filter passes every query through unchanged', 'SELECT 1' === q( 'SELECT 1' ) );
shutdown();
ok( 'shutdown wrote the learned list once, autoloaded', 1 === $GLOBALS['updates'] && true === $GLOBALS['autoload']['skyphusion_hot_options'] );
ok( 'it holds the two single-row misses, not the transients', array( 'woocommerce_task_list_hidden', 'wc_feature_x' ) === $GLOBALS['opts']['skyphusion_hot_options'] );

// Request 2, another cold isolate: the list (from alloptions) is primed in one call; nothing new is learned, no write.
$GLOBALS['filters'] = array(); $GLOBALS['actions'] = array(); $GLOBALS['primed'] = array(); $GLOBALS['updates'] = 0;
$GLOBALS['skyphusion_option_prime_loaded'] = false;
require __DIR__ . '/../php/option-prime.php';
ok( 'the learned list is primed once, in one call', array( array( 'woocommerce_task_list_hidden', 'wc_feature_x' ) ) === $GLOBALS['primed'] );
shutdown();
ok( 'no new name: no write (no options version bump)', 0 === $GLOBALS['updates'] );

// Request 3: one new miss grows the list, merged and deduplicated.
$GLOBALS['filters'] = array(); $GLOBALS['actions'] = array(); $GLOBALS['updates'] = 0;
$GLOBALS['skyphusion_option_prime_loaded'] = false;
require __DIR__ . '/../php/option-prime.php';
q( "SELECT option_value FROM wp_options WHERE option_name = 'wc_feature_x' LIMIT 1" );
q( "SELECT option_value FROM wp_options WHERE option_name = 'jetpack_options' LIMIT 1" );
shutdown();
ok( 'a new name is merged, an old one not repeated', array( 'woocommerce_task_list_hidden', 'wc_feature_x', 'jetpack_options' ) === $GLOBALS['opts']['skyphusion_hot_options'] && 1 === $GLOBALS['updates'] );

// The cap: the list never grows past SKYPHUSION_HOT_OPTIONS_MAX.
$GLOBALS['filters'] = array(); $GLOBALS['actions'] = array(); $GLOBALS['updates'] = 0;
$GLOBALS['skyphusion_option_prime_loaded'] = false;
require __DIR__ . '/../php/option-prime.php';
for ( $i = 0; $i < 600; $i++ ) { q( "SELECT option_value FROM wp_options WHERE option_name = 'opt_$i' LIMIT 1" ); }
shutdown();
ok( 'capped at SKYPHUSION_HOT_OPTIONS_MAX (' . SKYPHUSION_HOT_OPTIONS_MAX . ')', count( $GLOBALS['opts']['skyphusion_hot_options'] ) === SKYPHUSION_HOT_OPTIONS_MAX );

// #1090 review: a name whose value is over SKYPHUSION_HOT_OPTION_MAX_BYTES is never learned (a cold prime loads values).
$GLOBALS['opts'] = array( 'small_opt' => 'x', 'big_blob' => str_repeat( 'b', 70000 ) );
$GLOBALS['filters'] = array(); $GLOBALS['actions'] = array(); $GLOBALS['updates'] = 0;
$GLOBALS['skyphusion_option_prime_loaded'] = false;
require __DIR__ . '/../php/option-prime.php';
q( "SELECT option_value FROM wp_options WHERE option_name = 'small_opt' LIMIT 1" );
q( "SELECT option_value FROM wp_options WHERE option_name = 'big_blob' LIMIT 1" );
q( "SELECT option_value FROM wp_options WHERE option_name = 'gone_opt' LIMIT 1" );
shutdown();
$l = $GLOBALS['opts']['skyphusion_hot_options'];
ok( '#1090 a small value is learned', in_array( 'small_opt', $l, true ) );
ok( '#1090 a value over 64 KB is NOT learned', ! in_array( 'big_blob', $l, true ) && 65536 === SKYPHUSION_HOT_OPTION_MAX_BYTES );
ok( '#1090 a missing option is learned (it primes into notoptions, no value to load)', in_array( 'gone_opt', $l, true ) );

// #1090 review: a cold prime (it ran its query) reports how many values and bytes it loaded; a warm one says nothing.
$GLOBALS['filters'] = array(); $GLOBALS['actions'] = array(); $GLOBALS['bridge'] = array();
$GLOBALS['prime_rows'] = array( (object) array( 'option_name' => 'small_opt', 'option_value' => 'abc' ), (object) array( 'option_name' => 'gone_x', 'option_value' => str_repeat( 'z', 100 ) ) );
$GLOBALS['skyphusion_option_prime_loaded'] = false;
require __DIR__ . '/../php/option-prime.php';
$msg = $GLOBALS['bridge'] ? $GLOBALS['bridge'][0] : null;
ok( '#1090 a cold prime reports n and bytes to the Worker', is_array( $msg ) && isset( $msg['optionPrime'] ) && 2 === $msg['optionPrime']['n'] && 103 === $msg['optionPrime']['bytes'] && $msg['optionPrime']['listed'] === count( $GLOBALS['opts']['skyphusion_hot_options'] ) );
$GLOBALS['filters'] = array(); $GLOBALS['actions'] = array(); $GLOBALS['bridge'] = array(); $GLOBALS['prime_rows'] = array();
$GLOBALS['skyphusion_option_prime_loaded'] = false;
require __DIR__ . '/../php/option-prime.php';
ok( '#1090 a warm prime (no query) reports nothing', array() === $GLOBALS['bridge'] );

echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
exit( $fail ? 1 : 0 );
