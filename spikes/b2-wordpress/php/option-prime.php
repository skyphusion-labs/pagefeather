<?php
/**
 * Plugin Name: Option priming for a cold isolate (approach A, #1090)
 * Description: On approach A the object cache lives in each Worker isolate (its L1), so a request on a cold isolate
 *   read every not-autoloaded option it needed one query at a time: measured on cf759hx (strummer, #1144's trace), 52
 *   single-row reads at about 24 ms on a just-booted isolate for the posts list, from about 30 WooCommerce callers;
 *   the same isolate's next render, 0. The overflow pool (on by default, #1119) spreads requests over more isolates, so
 *   cold isolates are more frequent. This plugin keeps the site's learned list of those names in ONE autoloaded option
 *   (it arrives with alloptions, which a cold isolate reads in one query anyway) and primes them early in every request
 *   with core's wp_prime_option_caches: one IN query on a cold isolate, none on a warm one (core checks the cache first).
 *   A name is learned from core's own single-row miss (get_option's "SELECT option_value ... WHERE option_name = ...
 *   LIMIT 1"); the list is written only when it grows, so it converges: each write bumps the options version once.
 *   Transients are never listed. Approach A only (JS_OBJECT_CACHE_VERSIONED).
 * Bounds (#1090 review): a cold prime loads the VALUES, so a name whose value is over SKYPHUSION_HOT_OPTION_MAX_BYTES
 *   (64 KB) is never learned, and each cold prime reports its count and bytes to the Worker (an option-prime line).
 *   The list never shrinks: a deleted option is primed into notoptions (no value to load), and SKYPHUSION_HOT_OPTIONS_MAX
 *   (400 names) bounds it.
 */

if ( ! defined( 'JS_OBJECT_CACHE_VERSIONED' ) || ! empty( $GLOBALS['skyphusion_option_prime_loaded'] ) ) {
	return;
}
$GLOBALS['skyphusion_option_prime_loaded'] = true;
if ( ! defined( 'SKYPHUSION_HOT_OPTIONS_MAX' ) ) {
	define( 'SKYPHUSION_HOT_OPTIONS_MAX', 400 );
}
if ( ! defined( 'SKYPHUSION_HOT_OPTION_MAX_BYTES' ) ) {
	define( 'SKYPHUSION_HOT_OPTION_MAX_BYTES', 65536 );
}
$GLOBALS['skyphusion_option_misses'] = array();

$skyphusion_hot = get_option( 'skyphusion_hot_options' );
$skyphusion_hot = is_array( $skyphusion_hot ) ? array_values( array_filter( $skyphusion_hot, 'is_string' ) ) : array();
if ( $skyphusion_hot && function_exists( 'wp_prime_option_caches' ) ) {
	global $wpdb;
	$skyphusion_q0 = isset( $wpdb->num_queries ) ? (int) $wpdb->num_queries : 0;
	wp_prime_option_caches( $skyphusion_hot );
	// A cold prime ran its one IN query: report what it loaded (numbers only), so a read can see the memory it costs.
	if ( isset( $wpdb->num_queries ) && (int) $wpdb->num_queries > $skyphusion_q0 && function_exists( 'post_message_to_js' ) ) {
		$skyphusion_bytes = 0;
		$skyphusion_rows  = is_array( $wpdb->last_result ) ? $wpdb->last_result : array();
		foreach ( $skyphusion_rows as $skyphusion_row ) {
			$skyphusion_bytes += isset( $skyphusion_row->option_value ) ? strlen( (string) $skyphusion_row->option_value ) : 0;
		}
		post_message_to_js( json_encode( array( 'optionPrime' => array( 'n' => count( $skyphusion_rows ), 'bytes' => $skyphusion_bytes, 'listed' => count( $skyphusion_hot ) ) ) ) );
	}
}

add_filter(
	'query',
	static function ( $sql ) {
		global $wpdb;
		$t = isset( $wpdb->options ) ? $wpdb->options : 'wp_options';
		if ( is_string( $sql ) && 0 === strpos( $sql, 'SELECT option_value FROM ' . $t . " WHERE option_name = '" )
			&& preg_match( "/^SELECT option_value FROM \\S+ WHERE option_name = '([^']{1,191})' LIMIT 1$/", $sql, $m )
			&& 0 !== strpos( $m[1], '_transient_' ) && 0 !== strpos( $m[1], '_site_transient_' ) ) {
			$GLOBALS['skyphusion_option_misses'][ $m[1] ] = true;
		}
		return $sql;
	}
);

add_action(
	'shutdown',
	static function () {
		if ( empty( $GLOBALS['skyphusion_option_misses'] ) ) {
			return;
		}
		$have = get_option( 'skyphusion_hot_options' );
		$have = is_array( $have ) ? array_values( array_filter( $have, 'is_string' ) ) : array();
		$new  = array();
		foreach ( array_diff( array_keys( $GLOBALS['skyphusion_option_misses'] ), $have ) as $name ) {
			// The value is in this request's cache already (the miss just loaded it): a big one is never learned.
			$v = get_option( $name, false );
			if ( strlen( (string) maybe_serialize( $v ) ) <= SKYPHUSION_HOT_OPTION_MAX_BYTES ) {
				$new[] = $name;
			}
		}
		if ( ! $new || count( $have ) >= SKYPHUSION_HOT_OPTIONS_MAX ) {
			return;
		}
		update_option( 'skyphusion_hot_options', array_slice( array_merge( $have, $new ), 0, SKYPHUSION_HOT_OPTIONS_MAX ), true );
	},
	1
);
