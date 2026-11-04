<?php
/**
 * Plugin Name: R2 Uploads
 * Description: Store the media library in Cloudflare R2 through the Worker's R2 binding.
 *
 * The design follows Human Made's S3 Uploads (https://github.com/humanmade/S3-Uploads,
 * GPL-2.0): a stream wrapper, and an upload_dir filter that points WordPress at it.
 * S3 Uploads talks to S3 over HTTPS with the AWS SDK. PHP in a Worker has no
 * network, so this wrapper sends each operation to the Worker with
 * post_message_to_js(), and the Worker calls its R2 binding. No keys, no HTTP.
 *
 * Files are r2://uploads/<path>. The Worker serves /wp-content/uploads/<path>
 * from the same bucket key, so URLs do not change.
 *
 * Active only when the Worker has an R2 binding (it defines R2_UPLOADS).
 */

if ( ! defined( 'R2_UPLOADS' ) || ! R2_UPLOADS || ! function_exists( 'post_message_to_js' ) ) {
	return;
}

class R2_Uploads_Stream {
	/** @var resource|null Set by PHP. */
	public $context;

	/** Directories made in this request. R2 has no directories, so a new empty one exists only here. */
	private static $dirs = array();

	private $key;
	private $buf;
	private $dirty = false;
	private $entries;

	/** Send one operation to the Worker. Returns the reply, or null on error. */
	public static function call( array $op ) {
		$reply = json_decode( post_message_to_js( json_encode( array( 'r2' => $op ) ) ), true );
		return ( is_array( $reply ) && ! empty( $reply['ok'] ) ) ? $reply : null;
	}

	public static function key( $uri ) {
		$path = preg_replace( '#^r2://#', '', $uri );
		$path = preg_replace( '#/+#', '/', $path );
		return trim( $path, '/' );
	}

	private static function content_type( $key ) {
		if ( function_exists( 'wp_check_filetype' ) ) {
			$t = wp_check_filetype( $key );
			if ( ! empty( $t['type'] ) ) {
				return $t['type'];
			}
		}
		return 'application/octet-stream';
	}

	private static function stat_array( $is_dir, $size = 0, $mtime = 0 ) {
		$mode = $is_dir ? 040777 : 0100666;
		$s    = array( 0, 0, $mode, 1, 0, 0, 0, $size, $mtime, $mtime, $mtime, -1, -1 );
		$keys = array( 'dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'atime', 'mtime', 'ctime', 'blksize', 'blocks' );
		return array_merge( $s, array_combine( $keys, $s ) );
	}

	public function stream_open( $uri, $mode, $options, &$opened_path ) {
		$this->key = self::key( $uri );
		$this->buf = fopen( 'php://temp', 'w+b' );
		$m         = $mode[0];
		if ( 'x' === $m ) {
			$h = self::call( array( 'op' => 'head', 'key' => $this->key ) );
			if ( ! $h || $h['found'] ) {
				return false;
			}
		}
		if ( 'r' === $m || 'a' === $m || 'c' === $m ) {
			$r = self::call( array( 'op' => 'get', 'key' => $this->key ) );
			if ( $r && $r['found'] ) {
				fwrite( $this->buf, base64_decode( $r['body'] ) );
				if ( 'a' !== $m ) {
					rewind( $this->buf );
				}
			} elseif ( 'r' === $m ) {
				return false;
			}
		}
		// w and x make the file even when nothing is written.
		$this->dirty = in_array( $m, array( 'w', 'x' ), true );
		return true;
	}

	public function stream_read( $count ) {
		return fread( $this->buf, $count );
	}

	public function stream_write( $data ) {
		$this->dirty = true;
		return fwrite( $this->buf, $data );
	}

	public function stream_eof() {
		return feof( $this->buf );
	}

	public function stream_tell() {
		return ftell( $this->buf );
	}

	public function stream_seek( $offset, $whence = SEEK_SET ) {
		return 0 === fseek( $this->buf, $offset, $whence );
	}

	public function stream_truncate( $size ) {
		$this->dirty = true;
		return ftruncate( $this->buf, $size );
	}

	public function stream_stat() {
		$s = fstat( $this->buf );
		return self::stat_array( false, $s['size'], time() );
	}

	public function stream_flush() {
		if ( ! $this->dirty ) {
			return true;
		}
		$pos = ftell( $this->buf );
		rewind( $this->buf );
		$body = stream_get_contents( $this->buf );
		fseek( $this->buf, $pos );
		$ok          = null !== self::call( array( 'op' => 'put', 'key' => $this->key, 'type' => self::content_type( $this->key ), 'body' => base64_encode( $body ) ) );
		$this->dirty = ! $ok;
		return $ok;
	}

	public function stream_close() {
		$this->stream_flush();
		fclose( $this->buf );
	}

	public function stream_lock( $operation ) {
		return true;
	}

	public function stream_metadata( $uri, $option, $value ) {
		return true; // touch, chmod, chown: nothing to do on R2.
	}

	public function stream_set_option( $option, $arg1, $arg2 ) {
		return false;
	}

	public function stream_cast( $cast_as ) {
		return false;
	}

	public function url_stat( $uri, $flags ) {
		$key = self::key( $uri );
		if ( '' === $key || isset( self::$dirs[ $key ] ) ) {
			return self::stat_array( true );
		}
		$r = self::call( array( 'op' => 'head', 'key' => $key ) );
		if ( $r && $r['found'] ) {
			return self::stat_array( false, (int) $r['size'], (int) $r['mtime'] );
		}
		$l = self::call( array( 'op' => 'list', 'prefix' => $key . '/', 'limit' => 1 ) );
		if ( $l && ( $l['keys'] || $l['prefixes'] ) ) {
			return self::stat_array( true );
		}
		if ( ! ( $flags & STREAM_URL_STAT_QUIET ) ) {
			trigger_error( 'r2 file not found: ' . $key, E_USER_NOTICE );
		}
		return false;
	}

	public function unlink( $uri ) {
		return null !== self::call( array( 'op' => 'delete', 'key' => self::key( $uri ) ) );
	}

	public function rename( $from, $to ) {
		$from = self::key( $from );
		$to   = self::key( $to );
		$r    = self::call( array( 'op' => 'get', 'key' => $from ) );
		if ( ! $r || ! $r['found'] ) {
			return false;
		}
		if ( null === self::call( array( 'op' => 'put', 'key' => $to, 'type' => self::content_type( $to ), 'body' => $r['body'] ) ) ) {
			return false;
		}
		return null !== self::call( array( 'op' => 'delete', 'key' => $from ) );
	}

	public function mkdir( $uri, $mode, $options ) {
		$key = self::key( $uri );
		// With recursive, every parent exists too.
		$parts = explode( '/', $key );
		for ( $i = 1, $n = count( $parts ); $i <= $n; $i++ ) {
			self::$dirs[ implode( '/', array_slice( $parts, 0, $i ) ) ] = true;
		}
		return true;
	}

	public function rmdir( $uri, $options ) {
		unset( self::$dirs[ self::key( $uri ) ] );
		return true;
	}

	public function dir_opendir( $uri, $options ) {
		$prefix = self::key( $uri );
		$prefix = '' === $prefix ? '' : $prefix . '/';
		$l      = self::call( array( 'op' => 'list', 'prefix' => $prefix, 'limit' => 1000 ) );
		if ( ! $l ) {
			return false;
		}
		$names = array();
		foreach ( array_merge( $l['keys'], $l['prefixes'] ) as $k ) {
			$names[] = basename( rtrim( $k, '/' ) );
		}
		$this->entries = $names;
		return true;
	}

	public function dir_readdir() {
		$e = current( $this->entries );
		if ( false === $e ) {
			return false;
		}
		next( $this->entries );
		return $e;
	}

	public function dir_rewinddir() {
		reset( $this->entries );
		return true;
	}

	public function dir_closedir() {
		$this->entries = array();
		return true;
	}
}

stream_wrapper_register( 'r2', 'R2_Uploads_Stream', STREAM_IS_URL ) || wp_die( 'r2 stream wrapper: register failed' );

// Point the uploads directory at R2. URLs stay /wp-content/uploads/...; the Worker serves them.
add_filter(
	'upload_dir',
	function ( $dirs ) {
		$dirs['path']    = str_replace( WP_CONTENT_DIR, 'r2:/', $dirs['path'] );
		$dirs['basedir'] = str_replace( WP_CONTENT_DIR, 'r2:/', $dirs['basedir'] );
		return $dirs;
	}
);

// Core deletes attachment files through realpath(), which a stream does not have
// (S3 Uploads does the same). Delete the original, the edits and every size here.
add_action(
	'delete_attachment',
	function ( $post_id ) {
		$file = get_attached_file( $post_id, true );
		if ( ! $file || 0 !== strpos( $file, 'r2://' ) ) {
			return;
		}
		$dir   = dirname( $file );
		$meta  = wp_get_attachment_metadata( $post_id );
		$files = array( $file );
		if ( ! empty( $meta['original_image'] ) ) {
			$files[] = $dir . '/' . $meta['original_image'];
		}
		foreach ( (array) ( $meta['sizes'] ?? array() ) as $size ) {
			if ( ! empty( $size['file'] ) ) {
				$files[] = $dir . '/' . $size['file'];
			}
		}
		foreach ( (array) get_post_meta( $post_id, '_wp_attachment_backup_sizes', true ) as $size ) {
			if ( ! empty( $size['file'] ) ) {
				$files[] = $dir . '/' . $size['file'];
			}
		}
		foreach ( array_unique( $files ) as $f ) {
			@unlink( $f );
		}
	}
);

// Image sizes come from the Cloudflare Images binding, not GD, when the Worker
// has one (it defines CF_IMAGES). See cf-images-editor.php.
add_filter(
	'wp_image_editors',
	function ( $editors ) {
		if ( defined( 'CF_IMAGES' ) && CF_IMAGES ) {
			require_once __DIR__ . '/r2-uploads/cf-images-editor.php';
			array_unshift( $editors, 'CF_Images_Editor' );
		}
		return $editors;
	}
);

// wp_unique_filename() checks, then writes. Two uploads of the same name on two
// isolates can both pass the check, and the second overwrites the first
// (measured 2026-11-04: 8 parallel uploads, 3 distinct files). The Worker
// reserves each name with one atomic D1 insert, so only one upload gets it.
add_filter(
	'wp_unique_filename',
	function ( $filename, $ext, $dir ) {
		if ( 0 !== strpos( $dir, 'r2://' ) ) {
			return $filename;
		}
		$base = ( $ext && substr( $filename, -strlen( $ext ) ) === $ext ) ? substr( $filename, 0, -strlen( $ext ) ) : $filename;
		$name = $filename;
		for ( $i = 1; $i < 1000; $i++ ) {
			$r = R2_Uploads_Stream::call( array( 'op' => 'reserve', 'key' => R2_Uploads_Stream::key( $dir . '/' . $name ) ) );
			if ( ! $r ) {
				return $filename; // Reservation is not available. Keep what core chose.
			}
			if ( $r['reserved'] ) {
				return $name;
			}
			$name = $base . '-' . $i . $ext;
		}
		return $filename;
	},
	10,
	3
);
