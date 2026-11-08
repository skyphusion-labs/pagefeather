<?php
/**
 * Plugin Name: AI alt text (b-dosql)
 * Description: When an image is uploaded with no alt text, caption it with a
 *   Cloudflare Workers AI image-to-text model and set _wp_attachment_image_alt.
 *   Accessibility and SEO, zero config. The caption is made by the Worker's AI
 *   binding, not in PHP: PHP sends the image's public URL (and its R2 key) to
 *   index.js through the post_message_to_js bridge (aiAlt op), the Worker calls
 *   env.AI, and PHP writes the returned alt text. The image bytes never enter
 *   PHP, and with the default (URL) path they never enter the Durable Object
 *   isolate either, so the 128 MiB upload ceiling (issue #189) is untouched.
 *
 *   b-dosql only (SKYPHUSION_AI_ALT, written by index.js when PHP_IN_DO and
 *   DB_IN_DO are on, the MEDIA binding and the AI binding are present, and
 *   AI_ALT is not "off"). AI_ALT=off disables it.
 *
 * Fail safe. The upload must always complete. If the AI call errors, is slow,
 * or returns nothing, the alt text is left empty and the upload is untouched:
 * this plugin never throws and never changes the upload result. It also runs
 * AFTER the attachment row and its sizes are stored (wp_generate_attachment_metadata,
 * late priority), never on the insert critical path.
 */

if ( ! defined( 'SKYPHUSION_AI_ALT' ) || ! SKYPHUSION_AI_ALT || ! function_exists( 'skyphusion_worker_call' ) ) {
	return;
}

/** Image types a captioning model can read. */
if ( ! function_exists( 'skyphusion_ai_alt_mimes' ) ) {
	function skyphusion_ai_alt_mimes() {
		return array( 'image/jpeg', 'image/png', 'image/webp', 'image/gif' );
	}
}

/**
 * Caption a freshly uploaded image that has no alt text. Hooked on
 * wp_generate_attachment_metadata, which runs after the attachment post and its
 * sub-sizes exist, so the row is already stored and a small rendition is ready.
 *
 * @param array $metadata      The attachment metadata (returned unchanged).
 * @param int   $attachment_id The attachment post ID.
 * @return array The metadata, never modified here.
 */
function skyphusion_ai_alt_generate( $metadata, $attachment_id ) {
	// Any failure leaves the upload exactly as it was.
	try {
		$attachment_id = (int) $attachment_id;
		if ( $attachment_id <= 0 ) {
			return $metadata;
		}
		// Images only, and only types the model can read.
		$mime = get_post_mime_type( $attachment_id );
		if ( ! in_array( $mime, skyphusion_ai_alt_mimes(), true ) ) {
			return $metadata;
		}
		// Only when the user has not already written alt text. If they add their
		// own later, update_post_meta from the editor overwrites ours; the user wins.
		$existing = get_post_meta( $attachment_id, '_wp_attachment_image_alt', true );
		if ( '' !== trim( (string) $existing ) ) {
			return $metadata;
		}

		// The file lives on R2 (the Worker reads the MEDIA binding). r2-uploads.php
		// points the uploads directory at r2://; the public URL stays /wp-content/uploads.
		$base = get_attached_file( $attachment_id, true );
		if ( ! is_string( $base ) || 0 !== strpos( $base, 'r2://' ) ) {
			return $metadata;
		}

		// Caption a rendition, not the full-resolution original: enough detail for
		// a one-line description, less to fetch and fewer tokens. Fall back to the
		// original when no sub-size was made (small images).
		$rel = is_array( $metadata ) && ! empty( $metadata['file'] ) ? $metadata['file'] : null;
		if ( is_array( $metadata ) && ! empty( $metadata['sizes'] ) && ! empty( $metadata['file'] ) ) {
			$dir = dirname( $metadata['file'] );
			$dir = ( '.' === $dir || '' === $dir ) ? '' : $dir . '/';
			foreach ( array( 'large', 'medium_large', 'medium' ) as $name ) {
				if ( ! empty( $metadata['sizes'][ $name ]['file'] ) ) {
					$rel = $dir . $metadata['sizes'][ $name ]['file'];
					break;
				}
			}
		}
		if ( ! is_string( $rel ) || '' === $rel ) {
			return $metadata;
		}

		// Public URL (default, isolate-safe path) and R2 key (fallback) for the
		// chosen rendition. wp_get_upload_dir()['baseurl'] is the normal public
		// base; ['basedir'] is the r2:// path, from which the Worker derives the key.
		$upload = wp_get_upload_dir();
		if ( ! is_array( $upload ) || empty( $upload['baseurl'] ) || empty( $upload['basedir'] ) ) {
			return $metadata;
		}
		$url = rtrim( $upload['baseurl'], '/' ) . '/' . ltrim( $rel, '/' );
		$key = class_exists( 'R2_Uploads_Stream' )
			? R2_Uploads_Stream::key( rtrim( $upload['basedir'], '/' ) . '/' . ltrim( $rel, '/' ) )
			: ltrim( preg_replace( '#^r2://#', '', rtrim( $upload['basedir'], '/' ) . '/' . ltrim( $rel, '/' ) ), '/' );

		// Ask the Worker. It calls env.AI and returns { ok, alt } or { ok, degraded }.
		$reply = json_decode(
			skyphusion_worker_call(
				wp_json_encode(
					array(
						'aiAlt' => array(
							'url'  => $url,
							'key'  => $key,
							'mime' => $mime,
						),
					)
				)
			),
			true
		);
		if ( ! is_array( $reply ) || empty( $reply['alt'] ) || ! is_string( $reply['alt'] ) ) {
			return $metadata; // No caption: leave the alt text empty (fail safe).
		}

		$alt = sanitize_text_field( $reply['alt'] );
		if ( '' !== $alt ) {
			update_post_meta( $attachment_id, '_wp_attachment_image_alt', $alt );
		}
	} catch ( Throwable $e ) {
		// Never let captioning affect the upload.
		if ( function_exists( 'error_log' ) ) {
			error_log( 'ai-alt-text: ' . $e->getMessage() );
		}
	}
	return $metadata;
}

add_filter( 'wp_generate_attachment_metadata', 'skyphusion_ai_alt_generate', 20, 2 );
