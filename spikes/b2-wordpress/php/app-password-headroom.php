<?php
/**
 * Plugin Name: Application password headroom (b-dosql)
 * Description: A core application-password REST call does not load WooCommerce.
 *
 * Why. b-dosql keeps PHP and SQLite in one Durable Object. The cap is 128 MiB.
 * A WooCommerce admin page ends near x-wasm-mib 104. The next write then has
 * little free heap. WooCommerce registers hundreds of REST routes on every
 * request. That step is about 10 MiB, and the plugin itself is about 37 MiB
 * (docs/support-matrix.md, #768). Measured on cf759a at build 83056b7
 * (2026-11-19): POST /wp/v2/users/1/application-passwords answered 500 with
 * x-isolate-reset: memory and x-write-loss: 1. The profile page had just
 * ended at x-wasm-mib 104. The Revoke button never appeared.
 *
 * This request only reads and writes the core application-password list.
 * WooCommerce is not needed for that. The mu-plugin drops woocommerce/ from
 * active plugins for this route only. Other plugins stay. WooCommerce's own
 * routes stay on their own requests. It also returns PHP's allocator caches
 * to the heap before plugins load, so the call can fit in the heap it has.
 *
 * Gate: SKYPHUSION_APP_PASSWORD_HEADROOM. index.js defines it on b-dosql.
 * APP_PASSWORD_HEADROOM=off does not define it.
 */

if ( ! defined( 'SKYPHUSION_APP_PASSWORD_HEADROOM' ) || ! SKYPHUSION_APP_PASSWORD_HEADROOM ) {
	return;
}

if ( ! function_exists( 'skyphusion_app_password_headroom_route' ) ) {
	/**
	 * The core application-password REST route, or an empty string.
	 *
	 * @return string
	 */
	function skyphusion_app_password_headroom_route() {
		$uri  = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
		$path = (string) parse_url( $uri, PHP_URL_PATH );
		$rest = isset( $_GET['rest_route'] ) ? (string) $_GET['rest_route'] : '';
		if ( '' === $rest && 0 === strpos( $path, '/wp-json/' ) ) {
			$rest = substr( $path, strlen( '/wp-json' ) );
			$qpos = strpos( $rest, '?' );
			if ( false !== $qpos ) {
				$rest = substr( $rest, 0, $qpos );
			}
		}
		if ( preg_match( '#^/wp/v2/users/[^/]+/application-passwords(?:/|$)#', $rest ) ) {
			return $rest;
		}
		return '';
	}
}

if ( ! function_exists( 'skyphusion_app_password_headroom_plugins' ) ) {
	/**
	 * Drop the WooCommerce plugin. Leave every other plugin in place.
	 *
	 * @param mixed $plugins Active plugin basenames.
	 * @return mixed
	 */
	function skyphusion_app_password_headroom_plugins( $plugins ) {
		if ( ! is_array( $plugins ) ) {
			return $plugins;
		}
		$out = array();
		foreach ( $plugins as $plugin ) {
			if ( 0 === strpos( (string) $plugin, 'woocommerce/' ) ) {
				continue;
			}
			$out[] = $plugin;
		}
		return $out;
	}
}

if ( ! function_exists( 'skyphusion_app_password_headroom_free' ) ) {
	/**
	 * Give the allocator's cached blocks back to the heap.
	 */
	function skyphusion_app_password_headroom_free() {
		if ( function_exists( 'gc_collect_cycles' ) ) {
			gc_collect_cycles();
		}
		if ( function_exists( 'gc_mem_caches' ) ) {
			gc_mem_caches();
		}
		if ( function_exists( 'wp_cache_flush' ) ) {
			wp_cache_flush();
		}
	}
}

if ( '' === skyphusion_app_password_headroom_route() ) {
	return;
}

skyphusion_app_password_headroom_free();

add_filter( 'option_active_plugins', 'skyphusion_app_password_headroom_plugins', 1 );
add_action( 'plugins_loaded', 'skyphusion_app_password_headroom_free', 0 );
