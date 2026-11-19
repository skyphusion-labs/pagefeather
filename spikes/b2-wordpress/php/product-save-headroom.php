<?php
/**
 * Plugin Name: Product admin headroom (b-dosql)
 * Description: A hot post.php or admin-ajax.php write reuses the heap it already has.
 *
 * Why. b-dosql keeps one PHP runtime. The wasm heap does not shrink.
 * The recycle line is 140 MiB, so a runtime that ends near 117 MiB is kept (#768).
 * The isolate cap is 128 MiB. The next product admin write grows that heap.
 * The platform resets the isolate. The write rolls back (#963).
 * A quiet REST product create does not sit on that heap, so it still returns 201.
 *
 * This request gives allocator caches back to the heap before plugins load.
 * It caps the JS object cache at 1 MiB for this request only.
 * The next request restores the 8 MiB cap. WooCommerce stays loaded.
 * A REST product route is not this request.
 *
 * Gate: SKYPHUSION_PRODUCT_HEADROOM. index.js defines it on b-dosql.
 * PRODUCT_HEADROOM=off does not define it.
 */

if ( ! defined( 'SKYPHUSION_PRODUCT_HEADROOM' ) || ! SKYPHUSION_PRODUCT_HEADROOM ) {
	return;
}

if ( ! function_exists( 'skyphusion_product_headroom_script' ) ) {
	/**
	 * post.php, post-new.php, or admin-ajax.php. Empty for every other request.
	 *
	 * @return string
	 */
	function skyphusion_product_headroom_script() {
		$uri  = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
		$path = (string) parse_url( $uri, PHP_URL_PATH );
		$base = basename( $path );
		if ( in_array( $base, array( 'post.php', 'post-new.php', 'admin-ajax.php' ), true ) ) {
			return $base;
		}
		return '';
	}
}

if ( ! function_exists( 'skyphusion_product_headroom_free' ) ) {
	/**
	 * Give the allocator caches back to the heap.
	 */
	function skyphusion_product_headroom_free() {
		if ( function_exists( 'gc_collect_cycles' ) ) {
			gc_collect_cycles();
		}
		if ( function_exists( 'gc_mem_caches' ) ) {
			gc_mem_caches();
		}
	}
}

if ( ! function_exists( 'skyphusion_product_headroom_cap' ) ) {
	/**
	 * Cap the JS object cache at 1 MiB and drop what is already stored.
	 */
	function skyphusion_product_headroom_cap() {
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

if ( '' === skyphusion_product_headroom_script() ) {
	return;
}

skyphusion_product_headroom_free();
skyphusion_product_headroom_cap();

add_action( 'plugins_loaded', 'skyphusion_product_headroom_free', 0 );
