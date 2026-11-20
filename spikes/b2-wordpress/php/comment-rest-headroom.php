<?php
/**
 * Plugin Name: Comment REST headroom (b-dosql)
 * Description: A block note save reuses the heap the editor already holds.
 *
 * Why. b-dosql keeps one PHP runtime. The wasm heap does not shrink.
 * The recycle line is 140 MiB. post-new.php ends near 112 to 115 MiB and is kept.
 * The isolate cap is 128 MiB. The JS object cache sits beside that heap.
 * The next POST /wp/v2/comments grows the total past the cap.
 * The platform resets the isolate. The note answers 500 with x-write-loss 1.
 * Measured on cf759a at build 83056b7 (2026-11-19). A quiet probe can still return 201.
 *
 * This request gives allocator caches back to the heap before plugins load.
 * It caps the JS object cache at 1 MiB for this request only.
 * The next request restores the 8 MiB cap. WooCommerce stays loaded.
 * A review route under /wc does not match.
 *
 * Gate: SKYPHUSION_COMMENT_HEADROOM. index.js defines it on b-dosql.
 * COMMENT_HEADROOM=off does not define it.
 */

if ( ! defined( 'SKYPHUSION_COMMENT_HEADROOM' ) || ! SKYPHUSION_COMMENT_HEADROOM ) {
	return;
}

if ( ! function_exists( 'skyphusion_comment_headroom_route' ) ) {
	/**
	 * The core comments REST route, or an empty string.
	 *
	 * Plain permalinks use /index.php/wp-json/wp/v2/comments.
	 *
	 * @return string
	 */
	function skyphusion_comment_headroom_route() {
		$uri   = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
		$query = parse_url( $uri, PHP_URL_QUERY );
		$route = '';
		if ( is_string( $query ) && preg_match( '/(?:^|&)rest_route=([^&]*)/', $query, $match ) ) {
			$route = rawurldecode( $match[1] );
		} else {
			$path = (string) parse_url( $uri, PHP_URL_PATH );
			if ( preg_match( '#/wp-json(/.*)?$#', $path, $match ) ) {
				$route = ( isset( $match[1] ) && '' !== $match[1] && '/' !== $match[1] ) ? $match[1] : '/';
			}
		}
		$route = '/' . ltrim( (string) $route, '/' );
		if ( preg_match( '#^/wp/v2/comments(?:/|$)#', $route ) ) {
			return $route;
		}
		return '';
	}
}

if ( ! function_exists( 'skyphusion_comment_headroom_free' ) ) {
	/**
	 * Give the allocator caches back to the heap.
	 */
	function skyphusion_comment_headroom_free() {
		if ( function_exists( 'gc_collect_cycles' ) ) {
			gc_collect_cycles();
		}
		if ( function_exists( 'gc_mem_caches' ) ) {
			gc_mem_caches();
		}
	}
}

if ( ! function_exists( 'skyphusion_comment_headroom_cap' ) ) {
	/**
	 * Cap the JS object cache at 1 MiB and drop what is already stored.
	 */
	function skyphusion_comment_headroom_cap() {
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

if ( '' === skyphusion_comment_headroom_route() ) {
	return;
}

skyphusion_comment_headroom_free();
skyphusion_comment_headroom_cap();

add_action( 'plugins_loaded', 'skyphusion_comment_headroom_free', 0 );
