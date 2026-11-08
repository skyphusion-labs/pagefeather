<?php
/**
 * Plugin Name: CF Images upload trim (b-dosql)
 * Description: Cuts the two heaviest pieces of upload-path PHP work that are
 *   redundant when the Cloudflare Images binding handles images, so a media
 *   upload does not tip a WooCommerce-warmed b-dosql isolate past the 128 MiB
 *   cap (issue #189). Active only on the b-dosql + CF Images path, via the
 *   SKYPHUSION_IMAGES_UPLOAD_TRIM define that index.js writes.
 *
 * Why this is safe to trim on this path:
 *   - cf-images-editor.php sends every resize, crop and rotate to the Worker's
 *     Images binding, and the binding applies EXIF orientation itself. So PHP
 *     does not need to read EXIF to orient the image, and the image dimensions
 *     come from wp_getimagesize()/the editor, not from the EXIF block.
 *   - CF Images can serve any size on the fly, so the large srcset-only
 *     intermediate sizes do not have to be generated at upload time.
 *
 * Measured context (issue #189): on a WooCommerce-warmed isolate at the steady
 * ~99 MiB (about 29 MiB of headroom under the 128 MiB cap), a media upload can
 * tip past 128 (exceededMemory, 503). The increment is upload-path CODE, not
 * pixels: wp_read_image_metadata (EXIF/IPTC) and wp_create_image_subsizes
 * iterating WooCommerce's many registered sizes.
 */

if ( ! defined( 'SKYPHUSION_IMAGES_UPLOAD_TRIM' ) || ! SKYPHUSION_IMAGES_UPLOAD_TRIM ) {
	return;
}

/*
 * Lever 1: do not read EXIF in PHP.
 *
 * The load-bearing hook is wp_read_image_metadata_types, NOT the
 * wp_read_image_metadata output filter. In wp-admin/includes/image.php the
 * function calls exif_read_data() (the memory-heavy read: it pulls every tag
 * and any embedded thumbnail into PHP memory) only when the image type is in
 * the list this filter returns; the wp_read_image_metadata filter fires AFTER
 * that read has already run, so filtering the output would not save the memory.
 * Returning an empty list means exif_read_data() is never called.
 *
 * CF Images applies orientation, so the one EXIF field WordPress acts on here
 * (orientation) is already handled before PHP sees the image.
 */
add_filter( 'wp_read_image_metadata_types', '__return_empty_array' );

/*
 * Keep the stored attachment image_meta empty and consistent on this path. This
 * does NOT save the read (see above); it just means no EXIF/IPTC-derived fields
 * are persisted now that the EXIF read is off, so the record is predictable.
 */
add_filter(
	'wp_read_image_metadata',
	function () {
		return array();
	}
);

/*
 * Lever 2: generate only the intermediate sizes the store actually references.
 *
 * wp_create_image_subsizes() iterates every registered size and makes each one
 * (through the Images binding here). WooCommerce registers a large set, and the
 * big srcset-only sizes (medium_large, 1536x1536, 2048x2048) are redundant when
 * CF Images serves responsive variants on the fly. Trimming the set shrinks the
 * per-size bookkeeping in the upload path and the number of Images jobs.
 *
 * This filter NEVER adds a size; it only drops sizes outside the keep-set, and
 * only names that are present in $new_sizes. The keep-set is overridable per
 * store with the skyphusion_images_upload_keep_sizes filter, so a theme that
 * references a different named size can add it back without code changes.
 */
add_filter(
	'intermediate_image_sizes_advanced',
	function ( $new_sizes ) {
		if ( ! is_array( $new_sizes ) ) {
			return $new_sizes;
		}
		/**
		 * The intermediate sizes to keep generating at upload time on the
		 * CF Images path. Core editor/blog sizes plus the WooCommerce sizes the
		 * catalogue, product page and gallery templates request by name.
		 *
		 * @param string[] $keep Size names to keep.
		 */
		$keep = apply_filters(
			'skyphusion_images_upload_keep_sizes',
			array(
				'thumbnail',
				'medium',
				'large',
				'woocommerce_thumbnail',
				'woocommerce_single',
				'woocommerce_gallery_thumbnail',
			)
		);
		$keep = array_flip( (array) $keep );
		foreach ( array_keys( $new_sizes ) as $name ) {
			if ( ! isset( $keep[ $name ] ) ) {
				unset( $new_sizes[ $name ] );
			}
		}
		return $new_sizes;
	},
	// After WooCommerce has registered its sizes (it filters at the default 10).
	20
);
