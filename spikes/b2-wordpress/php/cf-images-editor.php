<?php
/**
 * CF_Images_Editor: a WordPress image editor that does no pixel work in PHP.
 *
 * Every resize, crop, rotate and flip goes to the Worker's Cloudflare Images
 * binding. The Worker reads the source from R2, transforms it with Images, and
 * writes the result to R2. Image bytes never enter PHP's memory, so a large
 * photo cannot run the 128 MB isolate out of memory (measured 2026-11-04: GD
 * failed on a 3000x3000 PNG).
 *
 * Loaded by r2-uploads.php when the Worker has an IMAGES binding (CF_IMAGES).
 * Only for files on R2 (r2://). Other files use the normal editors.
 */

require_once ABSPATH . WPINC . '/class-wp-image-editor.php';

class CF_Images_Editor extends WP_Image_Editor {
	const MIME_TYPES = array( 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif' );

	/** @var string R2 key of the source file. */
	private $key;

	/** @var array Transforms for the Images binding, applied in order. */
	private $ops = array();

	public static function test( $args = array() ) {
		if ( ! defined( 'CF_IMAGES' ) || ! CF_IMAGES ) {
			return false;
		}
		return ! isset( $args['path'] ) || 0 === strpos( $args['path'], 'r2://' );
	}

	public static function supports_mime_type( $mime_type ) {
		return in_array( $mime_type, self::MIME_TYPES, true );
	}

	public function load() {
		if ( $this->key ) {
			return true;
		}
		if ( 0 !== strpos( $this->file, 'r2://' ) ) {
			return new WP_Error( 'error_loading_image', 'CF_Images_Editor: the file is not on R2.', $this->file );
		}
		$key = R2_Uploads_Stream::key( $this->file );
		$r   = R2_Uploads_Stream::call( array( 'op' => 'info', 'key' => $key ) );
		if ( ! $r || empty( $r['found'] ) || empty( $r['width'] ) || empty( $r['height'] ) ) {
			return new WP_Error( 'invalid_image', __( 'File is not an image.' ), $this->file );
		}
		$this->key       = $key;
		$this->mime_type = ! empty( $r['format'] ) ? $r['format'] : wp_check_filetype( $this->file )['type'];
		$this->update_size( (int) $r['width'], (int) $r['height'] );
		return $this->set_quality();
	}

	/** Cloudflare Images applies EXIF orientation itself. Do not rotate twice. */
	public function maybe_exif_rotate() {
		return false;
	}

	public function resize( $max_w, $max_h, $crop = false ) {
		if ( (int) $this->size['width'] === (int) $max_w && (int) $this->size['height'] === (int) $max_h ) {
			return true;
		}
		$dims = image_resize_dimensions( $this->size['width'], $this->size['height'], $max_w, $max_h, $crop );
		if ( ! $dims ) {
			return new WP_Error( 'error_getting_dimensions', __( 'Could not calculate resized image dimensions' ), $this->file );
		}
		list( , , $src_x, $src_y, $dst_w, $dst_h, $src_w, $src_h ) = $dims;
		return $this->crop( $src_x, $src_y, $src_w, $src_h, $dst_w, $dst_h );
	}

	public function crop( $src_x, $src_y, $src_w, $src_h, $dst_w = null, $dst_h = null, $src_abs = false ) {
		if ( $src_abs ) {
			$src_w -= $src_x;
			$src_h -= $src_y;
		}
		$src_x = (int) round( $src_x );
		$src_y = (int) round( $src_y );
		$src_w = (int) round( $src_w );
		$src_h = (int) round( $src_h );
		$dst_w = $dst_w ? (int) round( $dst_w ) : $src_w;
		$dst_h = $dst_h ? (int) round( $dst_h ) : $src_h;
		if ( $src_w < 1 || $src_h < 1 || $dst_w < 1 || $dst_h < 1 ) {
			return new WP_Error( 'image_crop_error', __( 'Image crop failed.' ), $this->file );
		}
		if ( $src_x || $src_y || $src_w !== (int) $this->size['width'] || $src_h !== (int) $this->size['height'] ) {
			$this->ops[] = array( 'trim' => array( 'left' => $src_x, 'top' => $src_y, 'width' => $src_w, 'height' => $src_h ) );
		}
		if ( $dst_w !== $src_w || $dst_h !== $src_h ) {
			$this->ops[] = array( 'width' => $dst_w, 'height' => $dst_h, 'fit' => 'squeeze' );
		}
		return $this->update_size( $dst_w, $dst_h );
	}

	/** WordPress angles are counter-clockwise. Images rotates clockwise, by 90, 180 or 270. */
	public function rotate( $angle ) {
		$angle = ( ( (int) $angle % 360 ) + 360 ) % 360;
		if ( 0 === $angle ) {
			return true;
		}
		if ( 0 !== $angle % 90 ) {
			return new WP_Error( 'image_rotate_error', 'CF_Images_Editor: only multiples of 90 degrees.', $this->file );
		}
		$this->ops[] = array( 'rotate' => ( 360 - $angle ) % 360 );
		if ( 180 !== $angle ) {
			$this->update_size( $this->size['height'], $this->size['width'] );
		}
		return true;
	}

	/** In WordPress, $vert mirrors left to right and $horz mirrors top to bottom (see the GD editor). */
	public function flip( $horz, $vert ) {
		$f = ( $vert ? 'h' : '' ) . ( $horz ? 'v' : '' );
		if ( '' !== $f ) {
			$this->ops[] = array( 'flip' => $f );
		}
		return true;
	}

	private function render( $dest_key, $mime, $return_body ) {
		$op = array(
			'op'     => 'image',
			'src'    => $this->key,
			'ops'    => $this->ops,
			'format' => $mime,
			'body'   => $return_body,
		);
		if ( $dest_key ) {
			$op['dest'] = $dest_key;
		}
		if ( in_array( $mime, array( 'image/jpeg', 'image/webp', 'image/avif' ), true ) ) {
			$op['quality'] = $this->get_quality();
		}
		return R2_Uploads_Stream::call( $op );
	}

	public function save( $destfilename = null, $mime_type = null ) {
		list( $filename, $extension, $mime_type ) = $this->get_output_format( $destfilename, $mime_type );
		if ( ! $filename ) {
			$filename = $this->generate_filename( null, null, $extension );
		}
		if ( 0 !== strpos( $filename, 'r2://' ) ) {
			return new WP_Error( 'image_save_error', 'CF_Images_Editor: the destination is not on R2.', $filename );
		}
		$r = $this->render( R2_Uploads_Stream::key( $filename ), $mime_type, false );
		if ( ! $r ) {
			return new WP_Error( 'image_save_error', __( 'Image Editor Save Failed' ) );
		}
		return array(
			'path'      => $filename,
			/** This filter is documented in wp-includes/class-wp-image-editor-gd.php */
			'file'      => wp_basename( apply_filters( 'image_make_intermediate_size', $filename ) ),
			'width'     => $this->size['width'],
			'height'    => $this->size['height'],
			'mime-type' => $mime_type,
			'filesize'  => (int) $r['size'],
		);
	}

	public function make_subsize( $size_data ) {
		if ( ! isset( $size_data['width'] ) && ! isset( $size_data['height'] ) ) {
			return new WP_Error( 'image_subsize_create_error', __( 'Cannot resize the image. Both width and height are not set.' ) );
		}
		$ops  = $this->ops;
		$size = $this->size;
		$r    = $this->resize( $size_data['width'] ?? 0, $size_data['height'] ?? 0, $size_data['crop'] ?? false );
		if ( ! is_wp_error( $r ) ) {
			$r = $this->save();
			if ( ! is_wp_error( $r ) ) {
				unset( $r['path'] );
			}
		}
		$this->ops  = $ops;
		$this->size = $size;
		return $r;
	}

	public function multi_resize( $sizes ) {
		$metadata = array();
		foreach ( $sizes as $name => $size_data ) {
			$meta = $this->make_subsize( $size_data );
			if ( ! is_wp_error( $meta ) ) {
				$metadata[ $name ] = $meta;
			}
		}
		return $metadata;
	}

	public function stream( $mime_type = null ) {
		list( , , $mime_type ) = $this->get_output_format( null, $mime_type );
		$r = $this->render( null, $mime_type, true );
		if ( ! $r ) {
			return new WP_Error( 'image_stream_error', 'CF_Images_Editor: render failed.' );
		}
		header( 'Content-Type: ' . $mime_type );
		echo base64_decode( $r['body'] ); // phpcs:ignore
		return true;
	}
}
