<?php
/**
 * Plugin Name: Navigation REST headroom (b-dosql)
 * Description: A hot navigation write reuses the heap the editor already holds.
 *
 * Why. b-dosql keeps one PHP runtime. The wasm heap does not shrink.
 * The recycle line is 140 MiB. Neighboring calls end near 101 to 114 MiB.
 * The isolate cap is 128 MiB. The JS object cache sits beside that heap.
 * POST /wp/v2/navigation then dies. The answer is 500 and x-write-loss is unknown.
 * A force delete of a post or a page resets the isolate the same way.
 * Some of those deletes fail SQL first. The answer is then 503.
 * x-sql-failure is the count. x-write-loss is none.
 * OPTIONS /batch/v1 and POST /batch/v1 fail the same way.
 * Measured on cf759a at build 83056b7 (2026-11-19).
 * Six navigation specs threw skyphusion_write_loss.
 *
 * This request gives allocator caches back to the heap before plugins load.
 * It caps the JS object cache at 1 MiB for this request only.
 * The next request restores the 8 MiB cap. WooCommerce stays loaded.
 * A GET list does not match. A comment route does not match.
 *
 * Gate: SKYPHUSION_NAV_HEADROOM. index.js defines it on b-dosql.
 * NAV_HEADROOM=off does not define it.
 */

if ( ! defined( 'SKYPHUSION_NAV_HEADROOM' ) || ! SKYPHUSION_NAV_HEADROOM ) {
	return;
}

if ( ! function_exists( 'skyphusion_nav_headroom_route' ) ) {
	/**
	 * The navigation write, the force delete, or the batch call. Empty otherwise.
	 *
	 * Plain permalinks use /index.php/wp-json/.
	 *
	 * @return string
	 */
	function skyphusion_nav_headroom_route() {
		$uri    = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
		$method = isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( (string) $_SERVER['REQUEST_METHOD'] ) : '';
		$query  = parse_url( $uri, PHP_URL_QUERY );
		$route  = '';
		if ( is_string( $query ) && preg_match( '/(?:^|&)rest_route=([^&]*)/', $query, $match ) ) {
			$route = rawurldecode( $match[1] );
		} else {
			$path = (string) parse_url( $uri, PHP_URL_PATH );
			if ( preg_match( '#/wp-json(/.*)?$#', $path, $match ) ) {
				$route = ( isset( $match[1] ) && '' !== $match[1] && '/' !== $match[1] ) ? $match[1] : '/';
			}
		}
		$route = '/' . ltrim( (string) $route, '/' );
		if ( preg_match( '#^/batch/v1/?$#', $route ) ) {
			return in_array( $method, array( 'OPTIONS', 'POST' ), true ) ? $route : '';
		}
		if ( preg_match( '#^/wp/v2/navigation(?:/\d+)?/?$#', $route ) ) {
			return in_array( $method, array( 'POST', 'PUT', 'PATCH', 'DELETE' ), true ) ? $route : '';
		}
		if ( preg_match( '#^/wp/v2/(?:posts|pages)/\d+/?$#', $route ) ) {
			return 'DELETE' === $method ? $route : '';
		}
		return '';
	}
}

if ( ! function_exists( 'skyphusion_nav_headroom_free' ) ) {
	/**
	 * Give the allocator caches back to the heap.
	 */
	function skyphusion_nav_headroom_free() {
		if ( function_exists( 'gc_collect_cycles' ) ) {
			gc_collect_cycles();
		}
		if ( function_exists( 'gc_mem_caches' ) ) {
			gc_mem_caches();
		}
	}
}

if ( ! function_exists( 'skyphusion_nav_headroom_cap' ) ) {
	/**
	 * Cap the JS object cache at 1 MiB and drop what is already stored.
	 */
	function skyphusion_nav_headroom_cap() {
		if ( function_exists( 'post_message_to_js' ) ) {
			$body = array( 'oc' => array( 'op' => 'cap', 'n' => 1048576 ) );
			$json = function_exists( 'wp_json_encode' ) ? wp_json_encode( $body ) : json_encode( $body );
			post_message_to_js( $json );
		}
		if ( function_exists( 'wp_cache_flush' ) && isset( $GLOBALS['wp_object_cache'] ) ) {
			wp_cache_flush();
		}
	}
}

if ( '' === skyphusion_nav_headroom_route() ) {
	return;
}

skyphusion_nav_headroom_free();
skyphusion_nav_headroom_cap();

add_action( 'plugins_loaded', 'skyphusion_nav_headroom_free', 0 );
