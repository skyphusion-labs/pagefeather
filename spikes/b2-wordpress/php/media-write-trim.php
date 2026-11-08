<?php
/**
 * Plugin Name: Media write trim (b-dosql)
 * Description: Frees isolate memory on the rare admin media-upload request so the
 *   attachment DB insert fits under the 128 MiB b-dosql isolate cap on a WooCommerce-warmed
 *   isolate (issue #189). Only the async-upload / media-REST write path is touched; the
 *   storefront and every other request are untouched. Gated to b-dosql + MEDIA via
 *   SKYPHUSION_MEDIA_WRITE_TRIM, whose value selects the levers.
 *
 * Why. b-dosql runs PHP + SQLite in one Durable Object (128 MiB isolate cap). A
 * WooCommerce-warmed isolate sits at about x-wasm-mib 99 (about 29 MiB headroom). An admin
 * media upload (POST /wp-admin/async-upload.php, action=upload-attachment) reaches the
 * attachment DB insert and fails there ("Could not insert attachment into the database")
 * for lack of headroom, with no isolate reset. The same upload on a b-dosql isolate with
 * WooCommerce not loaded (about mib 58) stores the attachment. So the cost is the
 * WooCommerce per-request working set, not the image bytes, which never enter PHP
 * (php/cf-images-editor.php resizes through the Images binding). See docs/results.md row
 * 168 and issue #189.
 *
 * Levers. SKYPHUSION_MEDIA_WRITE_TRIM is a comma list (default "wcskip,cacheflush,gc"):
 *   - wcskip: do not load WooCommerce on this one request (its working set is not needed to
 *     store an attachment), but still register the three woocommerce_* image sizes through a
 *     shim so wp_generate_attachment_metadata makes them and serveUpload does not 404 them.
 *     The sizes are a faithful port of wc_get_image_size() in WooCommerce 11.2.1
 *     (includes/wc-core-functions.php and WooCommerce::add_image_sizes), reading the same
 *     options and theme support, so a trimmed upload makes the same sub-sizes a normal
 *     upload would. Limitation: a third-party woocommerce_get_image_size_* filter is not
 *     applied here (WooCommerce is not loaded to add one); the pinned stack adds none.
 *   - cacheflush: flush the cross-request object cache (the JS Map in index.js) just before
 *     the insert, freeing isolate memory the write needs. It refills on later requests
 *     (perf loss only; uploads are occasional).
 *   - gc: run gc_collect_cycles() and gc_mem_caches() just before the insert.
 *
 * Perf loss on the upload request is acceptable: an admin media upload is a rare,
 * single-admin operation (project goal, issue #189).
 */

if ( ! defined( 'SKYPHUSION_MEDIA_WRITE_TRIM' ) || ! SKYPHUSION_MEDIA_WRITE_TRIM ) {
	return;
}

/**
 * This request's media-write test. Runs at mu-plugin load, before
 * wp_get_active_and_valid_plugins(), so wcskip can drop WooCommerce from
 * option_active_plugins for this request only. The write path is a POST to
 * async-upload.php (the admin modal and media-new.php both land there) or to the
 * wp/v2/media REST route.
 *
 * @return bool
 */
function skyphusion_mwt_is_media_write() {
	static $is = null;
	if ( null !== $is ) {
		return $is;
	}
	$is     = false;
	$method = isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( (string) $_SERVER['REQUEST_METHOD'] ) : '';
	if ( 'POST' !== $method ) {
		return $is;
	}
	$uri    = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
	$script = isset( $_SERVER['SCRIPT_NAME'] ) ? (string) $_SERVER['SCRIPT_NAME'] : '';
	$path   = (string) parse_url( $uri, PHP_URL_PATH );
	if ( false !== strpos( $script, '/wp-admin/async-upload.php' ) || false !== strpos( $path, '/wp-admin/async-upload.php' ) ) {
		$is = true;
		return $is;
	}
	$rest = isset( $_GET['rest_route'] ) ? (string) $_GET['rest_route'] : '';
	if ( '' === $rest && 0 === strpos( $path, '/wp-json/' ) ) {
		$rest = substr( $path, 8 );
	}
	if ( '' !== $rest && preg_match( '#^/wp/v2/media/?$#', $rest ) ) {
		$is = true;
	}
	return $is;
}

/**
 * The enabled levers, as a set keyed by name.
 *
 * @return array<string,bool>
 */
function skyphusion_mwt_modes() {
	static $modes = null;
	if ( null !== $modes ) {
		return $modes;
	}
	$names = array_filter( array_map( 'trim', explode( ',', (string) SKYPHUSION_MEDIA_WRITE_TRIM ) ) );
	$modes = array_fill_keys( $names, true );
	return $modes;
}

if ( ! skyphusion_mwt_is_media_write() ) {
	return;
}

$skyphusion_mwt_modes = skyphusion_mwt_modes();

// wcskip: do not load WooCommerce on this request, but keep its three image sizes.
if ( ! empty( $skyphusion_mwt_modes['wcskip'] ) ) {
	add_filter(
		'option_active_plugins',
		function ( $plugins ) {
			if ( ! is_array( $plugins ) ) {
				return $plugins;
			}
			return array_values(
				array_filter(
					$plugins,
					function ( $plugin ) {
						return 0 !== strpos( (string) $plugin, 'woocommerce/' );
					}
				)
			);
		},
		1
	);

	// WooCommerce registers woocommerce_thumbnail / woocommerce_single /
	// woocommerce_gallery_thumbnail on 'init' (WooCommerce::add_image_sizes). With
	// WooCommerce not loaded, register the same three sizes so wp_generate_attachment_metadata
	// still makes them. The maths is a faithful port of wc_get_image_size() (WooCommerce
	// 11.2.1), from the same options and theme support. php/cf-images-editor.php (a mu-plugin,
	// always loaded) does the actual resize through the Images binding, so skipping WooCommerce
	// does not change how the sub-sizes are made, only that they stay registered.
	add_action(
		'init',
		function () {
			$theme   = get_theme_support( 'woocommerce' );
			$theme   = ( is_array( $theme ) && isset( $theme[0] ) && is_array( $theme[0] ) ) ? $theme[0] : array();
			$support = function ( $key, $fallback ) use ( $theme ) {
				return isset( $theme[ $key ] ) ? $theme[ $key ] : $fallback;
			};

			// woocommerce_single: width from theme support or option, height free, no crop.
			$single_w = absint( $support( 'single_image_width', get_option( 'woocommerce_single_image_width', 600 ) ) );
			add_image_size( 'woocommerce_single', $single_w, '', false );

			// woocommerce_gallery_thumbnail: square, cropped.
			$gallery_w = absint( $support( 'gallery_thumbnail_image_width', 100 ) );
			add_image_size( 'woocommerce_gallery_thumbnail', $gallery_w, $gallery_w, true );

			// woocommerce_thumbnail: width from theme support or option; height and crop from
			// the cropping option (1:1 default, "uncropped", or "custom" W:H).
			$thumb_w  = absint( $support( 'thumbnail_image_width', get_option( 'woocommerce_thumbnail_image_width', 300 ) ) );
			$cropping = get_option( 'woocommerce_thumbnail_cropping', '1:1' );
			if ( 'uncropped' === $cropping ) {
				add_image_size( 'woocommerce_thumbnail', $thumb_w, '', false );
			} elseif ( 'custom' === $cropping ) {
				$crop_w = max( 1, (float) get_option( 'woocommerce_thumbnail_cropping_custom_width', '4' ) );
				$crop_h = max( 1, (float) get_option( 'woocommerce_thumbnail_cropping_custom_height', '3' ) );
				add_image_size( 'woocommerce_thumbnail', $thumb_w, absint( round( ( $thumb_w / $crop_w ) * $crop_h ) ), true );
			} else {
				$parts  = explode( ':', (string) $cropping );
				$crop_w = max( 1, (float) reset( $parts ) );
				$crop_h = max( 1, (float) end( $parts ) );
				add_image_size( 'woocommerce_thumbnail', $thumb_w, absint( round( ( $thumb_w / $crop_w ) * $crop_h ) ), true );
			}
		},
		20
	);
}

// cacheflush / gc: free memory at the attachment DB insert. wp_insert_attachment_data
// fires inside wp_insert_post for an attachment, just before the $wpdb->insert that
// row 168 shows failing.
if ( ! empty( $skyphusion_mwt_modes['cacheflush'] ) || ! empty( $skyphusion_mwt_modes['gc'] ) ) {
	add_filter(
		'wp_insert_attachment_data',
		function ( $data ) use ( $skyphusion_mwt_modes ) {
			static $done = false;
			if ( $done ) {
				return $data;
			}
			$done = true;
			if ( ! empty( $skyphusion_mwt_modes['cacheflush'] ) && function_exists( 'wp_cache_flush' ) ) {
				wp_cache_flush();
			}
			if ( ! empty( $skyphusion_mwt_modes['gc'] ) ) {
				if ( function_exists( 'gc_collect_cycles' ) ) {
					gc_collect_cycles();
				}
				if ( function_exists( 'gc_mem_caches' ) ) {
					gc_mem_caches();
				}
			}
			return $data;
		},
		9999
	);
}
