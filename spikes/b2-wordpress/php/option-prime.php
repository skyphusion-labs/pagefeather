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
 */

if ( ! defined( 'JS_OBJECT_CACHE_VERSIONED' ) || ! empty( $GLOBALS['skyphusion_option_prime_loaded'] ) ) {
	return;
}
$GLOBALS['skyphusion_option_prime_loaded'] = true;
if ( ! defined( 'SKYPHUSION_HOT_OPTIONS_MAX' ) ) {
	define( 'SKYPHUSION_HOT_OPTIONS_MAX', 400 );
}
$GLOBALS['skyphusion_option_misses'] = array();

$skyphusion_hot = get_option( 'skyphusion_hot_options' );
$skyphusion_hot = is_array( $skyphusion_hot ) ? array_values( array_filter( $skyphusion_hot, 'is_string' ) ) : array();
if ( $skyphusion_hot && function_exists( 'wp_prime_option_caches' ) ) {
	wp_prime_option_caches( $skyphusion_hot );
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
		$new  = array_values( array_diff( array_keys( $GLOBALS['skyphusion_option_misses'] ), $have ) );
		if ( ! $new || count( $have ) >= SKYPHUSION_HOT_OPTIONS_MAX ) {
			return;
		}
		update_option( 'skyphusion_hot_options', array_slice( array_merge( $have, $new ), 0, SKYPHUSION_HOT_OPTIONS_MAX ), true );
	},
	1
);
