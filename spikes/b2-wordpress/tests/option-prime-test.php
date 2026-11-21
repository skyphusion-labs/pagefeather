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
function wp_prime_option_caches( $names ) { $GLOBALS['primed'][] = $names; }
class Stub_DB { public $options = 'wp_options'; }
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

echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
exit( $fail ? 1 : 0 );
