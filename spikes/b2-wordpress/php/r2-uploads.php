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

if ( ! defined( 'R2_UPLOADS' ) || ! R2_UPLOADS || ! function_exists( 'skyphusion_worker_call' ) ) {
	return;
}

class R2_Uploads_Stream {
	/** @var resource|null Set by PHP. */
	public $context;

	/** Directories made in this request. R2 has no directories, so a new empty one exists only here. */
	private static $dirs = array();

	/** Read-only opens fetch byte ranges of this size, not the whole object. */
	const CHUNK = 1048576;

	/** Bytes that wp_get_image_alttext() may read. */
	const METADATA_PREFIX = 1048576;

	private $key;
	private $buf;
	private $lazy = false;
	private $size = 0;
	private $pos = 0;
	private $chunk_at = -1;
	private $chunk = '';
	private $mtime = 0;
	private $dirty = false;
	private $entries;

	/**
	 * HEAD results in this request. WordPress calls file_exists() and is_dir()
	 * many times per upload (measured 2026-11-04: 25 HEAD and 10 LIST calls,
	 * 3 to 4 s). A write, copy or delete through this class clears the entry.
	 */
	private static $heads = array();

	/** Send one operation to the Worker. Returns the reply, or null on error. */
	public static function call( array $op ) {
		if ( 'head' === $op['op'] && isset( self::$heads[ $op['key'] ] ) ) {
			return self::$heads[ $op['key'] ];
		}
		foreach ( array( 'key', 'to', 'from', 'dest' ) as $k ) {
			if ( isset( $op[ $k ] ) && 'head' !== $op['op'] && 'get' !== $op['op'] && 'info' !== $op['op'] ) {
				unset( self::$heads[ $op[ $k ] ] );
			}
		}
		if ( 'images' === $op['op'] ) {
			foreach ( $op['jobs'] as $j ) {
				unset( self::$heads[ $j['dest'] ] );
			}
		}
		$reply = json_decode( skyphusion_worker_call( json_encode( array( 'r2' => $op ) ) ), true );
		$reply = ( is_array( $reply ) && ! empty( $reply['ok'] ) ) ? $reply : null;
		if ( 'head' === $op['op'] && $reply ) {
			self::$heads[ $op['key'] ] = $reply;
		}
		return $reply;
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
		$m         = $mode[0];
		// Read-only: fetch ranges on demand. getimagesize() and EXIF read only the
		// first bytes, so a large photo never comes into PHP whole.
		if ( 'r' === $m && false === strpos( $mode, '+' ) ) {
			$h = self::call( array( 'op' => 'head', 'key' => $this->key ) );
			if ( ! $h || ! $h['found'] ) {
				return false;
			}
			$this->lazy  = true;
			$this->size  = (int) $h['size'];
			$this->mtime = (int) $h['mtime'];
			// wp_get_image_alttext() reads the whole file to find XMP, twice per
			// upload (measured 2026-11-04: 116 range reads, 11 s, for a 13.7 MB
			// photo). In a JPEG, XMP is in an APP1 segment before the image data,
			// near the start. Give that function the first 1 MB only.
			if ( $this->size > self::METADATA_PREFIX ) {
				foreach ( debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS, 6 ) as $f ) {
					if ( 'wp_get_image_alttext' === $f['function'] ) {
						$this->size = self::METADATA_PREFIX;
						break;
					}
				}
			}
			return true;
		}
		$this->buf = fopen( 'php://temp', 'w+b' );
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
		if ( ! $this->lazy ) {
			return fread( $this->buf, $count );
		}
		$out = '';
		while ( $count > 0 && $this->pos < $this->size ) {
			$in_chunk = $this->chunk_at >= 0 && $this->pos >= $this->chunk_at && $this->pos < $this->chunk_at + strlen( $this->chunk );
			if ( ! $in_chunk ) {
				// The first read is small (headers). A read that goes on gets 1 MB at a time.
				$at  = $this->pos;
				$len = $this->chunk_at < 0 ? 65536 : self::CHUNK;
				$r   = self::call( array( 'op' => 'get', 'key' => $this->key, 'offset' => $at, 'length' => min( $len, $this->size - $at ) ) );
				if ( ! $r || ! $r['found'] ) {
					return $out;
				}
				$this->chunk    = base64_decode( $r['body'] );
				$this->chunk_at = $at;
			}
			$part       = substr( $this->chunk, $this->pos - $this->chunk_at, $count );
			if ( '' === $part ) {
				break;
			}
			$out       .= $part;
			$this->pos += strlen( $part );
			$count     -= strlen( $part );
		}
		return $out;
	}

	public function stream_write( $data ) {
		if ( $this->lazy ) {
			return 0;
		}
		$this->dirty = true;
		return fwrite( $this->buf, $data );
	}

	public function stream_eof() {
		return $this->lazy ? $this->pos >= $this->size : feof( $this->buf );
	}

	public function stream_tell() {
		return $this->lazy ? $this->pos : ftell( $this->buf );
	}

	public function stream_seek( $offset, $whence = SEEK_SET ) {
		if ( ! $this->lazy ) {
			return 0 === fseek( $this->buf, $offset, $whence );
		}
		$to = SEEK_SET === $whence ? $offset : ( SEEK_CUR === $whence ? $this->pos + $offset : $this->size + $offset );
		if ( $to < 0 ) {
			return false;
		}
		$this->pos = $to;
		return true;
	}

	public function stream_truncate( $size ) {
		$this->dirty = true;
		return ftruncate( $this->buf, $size );
	}

	public function stream_stat() {
		if ( $this->lazy ) {
			return self::stat_array( false, $this->size, $this->mtime );
		}
		$s = fstat( $this->buf );
		return self::stat_array( false, $s['size'], time() );
	}

	public function stream_flush() {
		if ( $this->lazy || ! $this->dirty ) {
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
		if ( $this->lazy ) {
			return;
		}
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
			self::$dirs[ $key ] = true;
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
		// The Worker copies inside R2. The bytes do not pass through PHP.
		$r = self::call( array( 'op' => 'copy', 'from' => self::key( $from ), 'to' => self::key( $to ), 'type' => self::content_type( $to ), 'move' => true ) );
		return $r && $r['found'];
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
			$key = R2_Uploads_Stream::key( $dir . '/' . $name );
			$r   = R2_Uploads_Stream::call( array( 'op' => 'reserve', 'key' => $key ) );
			if ( ! $r ) {
				// No reservation in the Worker (approach C1: one container with a
				// local database). add_option() is one INSERT on a unique key, so
				// only one request gets the name. The file must not exist in R2.
				$h = R2_Uploads_Stream::call( array( 'op' => 'head', 'key' => $key ) );
				$r = array( 'reserved' => ( ! $h || empty( $h['found'] ) ) && add_option( '_r2_reserved_' . md5( $key ), time(), '', false ) );
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

/*
 * Large uploads. The Worker stores a media upload of more than 1 MB in R2
 * under staging/ before PHP runs, and gives PHP a small marker file instead:
 * "R2STAGED" + newline + JSON {key, size, sniffed}. "sniffed" is the type the
 * Worker read from the file's first bytes. So a phone photo never comes into
 * PHP's memory. When WordPress has chosen the final name, the Worker copies the
 * staged object there inside R2.
 */
function skyphusion_r2_staged( $path ) {
	if ( ! is_string( $path ) || '' === $path || ! @is_file( $path ) || @filesize( $path ) > 4096 ) {
		return null;
	}
	$head = (string) @file_get_contents( $path, false, null, 0, 4096 );
	if ( 0 !== strpos( $head, "R2STAGED\n" ) ) {
		return null;
	}
	$m = json_decode( substr( $head, 9 ), true );
	return ( is_array( $m ) && ! empty( $m['key'] ) && 0 === strpos( $m['key'], 'staging/' ) ) ? $m : null;
}

// WordPress checks the real type from the file's bytes. For a staged upload the
// bytes are in R2, so use the type the Worker sniffed. An image must match its
// extension exactly, as core requires.
add_filter(
	'wp_check_filetype_and_ext',
	function ( $data, $file, $filename, $mimes ) {
		$m = skyphusion_r2_staged( $file );
		if ( ! $m ) {
			return $data;
		}
		$ft   = wp_check_filetype( $filename, $mimes );
		$deny = array( 'ext' => false, 'type' => false, 'proper_filename' => false );
		if ( ! $ft['type'] || ! empty( $m['dangerous'] ) ) {
			return $deny;
		}
		if ( 0 === strpos( $ft['type'], 'image/' ) && $m['sniffed'] !== $ft['type'] ) {
			return $deny;
		}
		return array( 'ext' => $ft['ext'], 'type' => $ft['type'], 'proper_filename' => false );
	},
	10,
	4
);

// After core moved the marker to its final r2:// path, put the real file there.
add_filter(
	'wp_handle_upload',
	function ( $upload ) {
		if ( empty( $upload['file'] ) || 0 !== strpos( $upload['file'], 'r2://' ) ) {
			return $upload;
		}
		$m = skyphusion_r2_staged( $upload['file'] );
		if ( ! $m ) {
			return $upload;
		}
		$r = R2_Uploads_Stream::call( array( 'op' => 'copy', 'from' => $m['key'], 'to' => R2_Uploads_Stream::key( $upload['file'] ), 'type' => $upload['type'], 'move' => true ) );
		if ( ! $r || ! $r['found'] ) {
			@unlink( $upload['file'] );
			return array( 'error' => 'The staged upload was not found in R2.' );
		}
		return $upload;
	}
);
