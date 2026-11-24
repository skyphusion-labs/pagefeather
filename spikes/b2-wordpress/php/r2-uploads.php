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

	/**
	 * This request's stat map. A positive file or directory may answer url_stat.
	 * An absent mark may answer only after this request deletes or moves the key.
	 * A list does not write absent marks. A missing direct child is absent only while
	 * that list's truncated value is boolean false.
	 */
	private static $stats = array();

	/** List prefix => direct child name => 'file' or 'dir'. Positive names only. */
	private static $list_children = array();

	/** List prefix => true when that reply's truncated value is boolean false. */
	private static $list_complete = array();

	/** Bytes from offset 0 for one key. At most METADATA_PREFIX. This request only. */
	private static $prefix_key = null;
	private static $prefix_buf = '';

	/** True after this request has registered the shutdown clear. */
	private static $clear_armed = false;

	/** File types whose extension may appear in a trace key shape. Anything else after the last dot is a name. */
	const TRACE_EXT = 'jpe?g|png|gif|webp|avif|heic|bmp|tiff?|svg|ico|pdf|zip|json|xml|txt|csv|mp3|mp4|m4a|wav|ogg|webm|mov|docx?|xlsx?|pptx?|css|js|html?|php';

	/**
	 * #1424 trace of this request's bridge calls. Operator-only. What it carries: the op, a key SHAPE (file names, dates
	 * and directory names replaced by placeholders), ms, a repeat count, and up to 5 callers per call as
	 * Class::function@file-base-name.php:line. Callers name the plugin or theme class, function and file base name that
	 * made the call (never arguments or paths), so a trace tells which plugin touches R2. It is returned only in
	 * x-r2-trace with a valid spike token and is never logged. Only with the operator header (index.js passes it only with the spike token). */
	private static $trace        = array();
	private static $trace_seen   = array();
	private static $trace_cached = 0;
	private static $trace_total  = 0;
	private static $trace_armed  = false;

	public static function tracing() {
		return ! empty( $_SERVER['HTTP_X_PF_R2_TRACE'] ) && function_exists( 'post_message_to_js' );
	}

	/** A key with its file names and dates replaced by placeholders: the layout, never the name. */
	public static function key_shape( $key ) {
		$key   = (string) $key;
		$trail = '/' === substr( $key, -1 ) ? '/' : '';
		$parts = explode( '/', trim( $key, '/' ) );
		$last  = count( $parts ) - 1;
		$out   = array();
		foreach ( $parts as $i => $p ) {
			if ( 0 === $i && 'uploads' === $p ) {
				$out[] = $p;
			} elseif ( preg_match( '/^\d{4}$/', $p ) ) {
				$out[] = '<yyyy>';
			} elseif ( preg_match( '/^\d{2}$/', $p ) ) {
				$out[] = '<mm>';
			} elseif ( $i === $last && '' === $trail ) {
				// Only a known file type stays: "report.2026" or "john.smith" end in a name, not an extension.
				$ext   = ( preg_match( '/\.(' . self::TRACE_EXT . ')$/i', $p, $m ) ) ? '.' . strtolower( $m[1] ) : '';
				$size  = ( '' !== $ext && preg_match( '/-\d+x\d+\.(' . self::TRACE_EXT . ')$/i', $p ) ) ? '-<w>x<h>' : '';
				$out[] = '<file>' . $size . $ext;
			} else {
				$out[] = '<dir>';
			}
		}
		return implode( '/', $out ) . $trail;
	}

	private static function trace_record( array $op, $ms ) {
		$k = '';
		if ( isset( $op['key'] ) ) {
			$k = self::key_shape( $op['key'] );
		} elseif ( isset( $op['prefix'] ) ) {
			$k = self::key_shape( $op['prefix'] );
		} elseif ( isset( $op['from'] ) ) {
			$k = self::key_shape( $op['from'] ) . '>' . self::key_shape( isset( $op['to'] ) ? $op['to'] : '' );
		} elseif ( isset( $op['jobs'] ) && is_array( $op['jobs'] ) ) {
			$k = 'jobs:' . count( $op['jobs'] );
		}
		$raw = $op['op'] . '|' . ( isset( $op['key'] ) ? $op['key'] : ( isset( $op['prefix'] ) ? $op['prefix'] : ( isset( $op['from'] ) ? $op['from'] . '>' . ( isset( $op['to'] ) ? $op['to'] : '' ) : '' ) ) );
		$d   = isset( self::$trace_seen[ $raw ] ) ? self::$trace_seen[ $raw ] : 0;
		self::$trace_seen[ $raw ] = $d + 1;
		$callers = array();
		foreach ( debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS, 14 ) as $f ) {
			if ( isset( $f['class'] ) && __CLASS__ === $f['class'] && in_array( $f['function'], array( 'call', 'trace_record' ), true ) ) {
				continue;
			}
			$fn = ( isset( $f['class'] ) ? $f['class'] . '::' : '' ) . ( isset( $f['function'] ) ? $f['function'] : '?' );
			$callers[] = $fn . ( isset( $f['file'] ) ? '@' . basename( $f['file'] ) . ':' . ( isset( $f['line'] ) ? $f['line'] : 0 ) : '' );
			if ( count( $callers ) >= 5 ) {
				break;
			}
		}
		++self::$trace_total;
		self::$trace[] = array( 'o' => $op['op'], 'k' => $k, 'ms' => round( $ms, 1 ), 'd' => $d, 'c' => $callers );
		if ( ! self::$trace_armed ) {
			self::$trace_armed = true;
			register_shutdown_function( array( __CLASS__, 'trace_flush' ) );
		}
	}

	/** Send the trace once, to the Worker's operator-only x-r2-trace header. Entries drop from the end to fit the header. */
	public static function trace_flush() {
		if ( ! self::tracing() || ! self::$trace ) {
			return;
		}
		$calls = self::$trace;
		do {
			$t = array( 'v' => 1, 'n' => self::$trace_total, 'cached' => self::$trace_cached, 'calls' => $calls );
			$j = json_encode( $t );
			if ( strlen( $j ) < 7800 || ! $calls ) {
				break;
			}
			array_pop( $calls );
		} while ( true );
		self::$trace = array();
		post_message_to_js( json_encode( array( 'r2Trace' => $t ) ) );
	}

	/** Register the request-end clear once. The runtime is reused, so the next request must arm it again. */
	public static function arm_request_clear() {
		if ( self::$clear_armed ) {
			return;
		}
		self::$clear_armed = true;
		register_shutdown_function( array( __CLASS__, 'request_clear' ) );
	}

	/** Drop the stat map, head cache, directory marks, and prefix bytes. The next request must not see them. */
	public static function request_clear() {
		self::$heads          = array();
		self::$dirs           = array();
		self::$stats          = array();
		self::$list_children  = array();
		self::$list_complete  = array();
		self::$prefix_key     = null;
		self::$prefix_buf     = '';
		self::$clear_armed    = false;
	}

	/** Send one operation to the Worker. Returns the reply, or null on error. */
	public static function call( array $op ) {
		self::arm_request_clear();
		// bridge: this head must hit the worker. A cached absent value must not answer it.
		$bridge = ! empty( $op['bridge'] );
		unset( $op['bridge'] );
		if ( ! $bridge && 'head' === $op['op'] && isset( self::$heads[ $op['key'] ] ) ) {
			if ( self::tracing() ) {
				++self::$trace_cached;
			}
			return self::$heads[ $op['key'] ];
		}
		foreach ( array( 'key', 'to', 'from', 'dest' ) as $k ) {
			if ( isset( $op[ $k ] ) && 'head' !== $op['op'] && 'get' !== $op['op'] && 'info' !== $op['op'] ) {
				unset( self::$heads[ $op[ $k ] ] );
			}
		}
		if ( 'images' === $op['op'] && isset( $op['jobs'] ) && is_array( $op['jobs'] ) ) {
			foreach ( $op['jobs'] as $j ) {
				if ( isset( $j['dest'] ) ) {
					self::drop_written( $j['dest'] );
				}
			}
		}
		if ( 'put' === $op['op'] || 'delete' === $op['op'] ) {
			if ( isset( $op['key'] ) ) {
				self::drop_written( $op['key'] );
			}
		} elseif ( 'copy' === $op['op'] && isset( $op['to'] ) ) {
			self::drop_written( $op['to'] );
		}
		$t0    = microtime( true );
		$reply = json_decode( skyphusion_worker_call( json_encode( array( 'r2' => $op ) ) ), true );
		if ( self::tracing() ) {
			self::trace_record( $op, ( microtime( true ) - $t0 ) * 1000 );
		}
		$reply = ( is_array( $reply ) && ! empty( $reply['ok'] ) ) ? $reply : null;
		if ( 'head' === $op['op'] && $reply ) {
			self::$heads[ $op['key'] ] = $reply;
			if ( ! empty( $reply['found'] ) ) {
				self::$stats[ $op['key'] ] = array(
					't'     => 'file',
					'size'  => (int) $reply['size'],
					'mtime' => (int) $reply['mtime'],
				);
			}
		}
		if ( 'list' === $op['op'] && $reply ) {
			self::list_fill( isset( $op['prefix'] ) ? (string) $op['prefix'] : '', $reply );
		}
		if ( 'delete' === $op['op'] && $reply && isset( $op['key'] ) ) {
			self::mark_absent( $op['key'], 'delete' );
		}
		if ( 'copy' === $op['op'] && $reply && ! empty( $op['move'] ) && ! empty( $reply['found'] ) && isset( $op['from'] ) ) {
			self::drop_written( $op['from'] );
			self::mark_absent( $op['from'], 'move' );
		}
		return $reply;
	}

	/** Forget one key after a write. The next stat heads. A parent list no longer proves the name absent. */
	private static function drop_written( $key ) {
		$key = (string) $key;
		unset( self::$heads[ $key ], self::$stats[ $key ], self::$dirs[ $key ] );
		list( $parent, $name ) = self::split_key( $key );
		unset( self::$list_complete[ $parent ] );
		if ( '' !== $name && isset( self::$list_children[ $parent ][ $name ] ) ) {
			unset( self::$list_children[ $parent ][ $name ] );
		}
		if ( self::$prefix_key === $key ) {
			self::$prefix_key = null;
			self::$prefix_buf = '';
		}
	}

	/** This request removed the key. url_stat may answer absent. A later put drops the mark. */
	private static function mark_absent( $key, $why ) {
		self::$stats[ (string) $key ] = array( 't' => 'absent', 'why' => $why );
	}

	private static function as_prefix( $prefix ) {
		$prefix = (string) $prefix;
		if ( '' === $prefix || '/' === substr( $prefix, -1 ) ) {
			return $prefix;
		}
		return $prefix . '/';
	}

	/** Parent prefix (with a trailing slash, or '') and the final name. */
	private static function split_key( $key ) {
		$key = trim( (string) $key, '/' );
		$pos = strrpos( $key, '/' );
		if ( false === $pos ) {
			return array( '', $key );
		}
		return array( substr( $key, 0, $pos + 1 ), substr( $key, $pos + 1 ) );
	}

	/** The direct child name, or null when the key sits deeper than this prefix. */
	private static function child_of( $prefix, $full ) {
		$full   = trim( (string) $full, '/' );
		$prefix = self::as_prefix( $prefix );
		$base   = trim( $prefix, '/' );
		if ( '' !== $base && 0 !== strpos( $full, $base . '/' ) ) {
			return null;
		}
		$rest = '' === $base ? $full : substr( $full, strlen( $base ) + 1 );
		if ( '' === $rest || false !== strpos( $rest, '/' ) ) {
			return null;
		}
		return $rest;
	}

	private static function mark_dir( $key ) {
		$key = trim( (string) $key, '/' );
		if ( '' === $key ) {
			return;
		}
		self::$dirs[ $key ] = true;
		if ( ! isset( self::$stats[ $key ] ) || 'dir' !== self::$stats[ $key ]['t'] ) {
			self::$stats[ $key ] = array( 't' => 'dir' );
		}
	}

	/** Each directory on the path of a returned key. The harness returns full keys and no prefixes. */
	private static function mark_path_dirs( $key ) {
		$key = trim( (string) $key, '/' );
		if ( '' === $key ) {
			return;
		}
		$parts = explode( '/', $key );
		array_pop( $parts );
		$path = '';
		foreach ( $parts as $p ) {
			if ( '' === $p ) {
				continue;
			}
			$path = '' === $path ? $p : $path . '/' . $p;
			self::mark_dir( $path );
		}
	}

	/** Store positive names from one list page. Only boolean truncated false may mark other children absent. */
	private static function list_fill( $prefix, array $reply ) {
		$prefix = self::as_prefix( $prefix );
		$keys   = ( isset( $reply['keys'] ) && is_array( $reply['keys'] ) ) ? $reply['keys'] : array();
		$prefs  = ( isset( $reply['prefixes'] ) && is_array( $reply['prefixes'] ) ) ? $reply['prefixes'] : array();
		$page   = array();
		foreach ( $keys as $k ) {
			$k = (string) $k;
			self::mark_path_dirs( $k );
			if ( ! isset( self::$stats[ $k ] ) || 'file' !== self::$stats[ $k ]['t'] ) {
				self::$stats[ $k ] = array( 't' => 'file', 'size' => 0, 'mtime' => 0 );
			}
			$name = self::child_of( $prefix, $k );
			if ( null !== $name ) {
				$page[ $name ] = 'file';
			}
		}
		foreach ( $prefs as $p ) {
			$dir = trim( (string) $p, '/' );
			self::mark_dir( $dir );
			self::mark_path_dirs( $dir );
			$name = self::child_of( $prefix, $dir );
			if ( null !== $name ) {
				$page[ $name ] = 'dir';
			}
		}
		$complete = array_key_exists( 'truncated', $reply ) && false === $reply['truncated'];
		if ( $complete ) {
			self::$list_children[ $prefix ] = $page;
			self::$list_complete[ $prefix ] = true;
			return;
		}
		$prev = isset( self::$list_children[ $prefix ] ) ? self::$list_children[ $prefix ] : array();
		self::$list_children[ $prefix ] = array_merge( $prev, $page );
		unset( self::$list_complete[ $prefix ] );
	}

	/**
	 * A cached stat, or null when this key must head.
	 * Absent is returned only for a delete, a move, or a missing direct child of a complete list.
	 */
	private static function stat_cached( $key ) {
		if ( isset( self::$stats[ $key ] ) ) {
			return self::$stats[ $key ];
		}
		list( $parent, $name ) = self::split_key( $key );
		if ( '' === $name || empty( self::$list_complete[ $parent ] ) ) {
			return null;
		}
		if ( isset( self::$list_children[ $parent ][ $name ] ) ) {
			if ( 'dir' === self::$list_children[ $parent ][ $name ] ) {
				return array( 't' => 'dir' );
			}
			return array( 't' => 'file', 'size' => 0, 'mtime' => 0 );
		}
		return array( 't' => 'absent', 'why' => 'list' );
	}

	/** Keep a get that continues the prefix from offset 0. A hole is not merged. A failed get is not stored. */
	private static function prefix_note( $key, $at, $bytes ) {
		$cap = self::METADATA_PREFIX;
		if ( null === self::$prefix_key ) {
			if ( 0 !== (int) $at ) {
				return;
			}
			self::$prefix_key = (string) $key;
			self::$prefix_buf = substr( $bytes, 0, $cap );
			return;
		}
		if ( self::$prefix_key !== (string) $key ) {
			return;
		}
		$have = strlen( self::$prefix_buf );
		if ( $have >= $cap || (int) $at !== $have ) {
			return;
		}
		self::$prefix_buf .= substr( $bytes, 0, $cap - $have );
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
			// Exclusive create always heads. A cached absent value must not skip this head.
			$h = self::call( array( 'op' => 'head', 'key' => $this->key, 'bridge' => true ) );
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
		$out         = '';
		$from_prefix = false;
		while ( $count > 0 && $this->pos < $this->size ) {
			// Copy local prefix bytes only for this stream's key. A later request has an empty buffer.
			if ( self::$prefix_key === $this->key && $this->pos < strlen( self::$prefix_buf ) ) {
				if ( ! $from_prefix && self::tracing() ) {
					++self::$trace_cached;
				}
				$from_prefix = true;
				$part        = substr( self::$prefix_buf, $this->pos, $count );
				if ( '' === $part ) {
					break;
				}
				$out       .= $part;
				$this->pos += strlen( $part );
				$count     -= strlen( $part );
				continue;
			}
			$in_chunk = $this->chunk_at >= 0 && $this->pos >= $this->chunk_at && $this->pos < $this->chunk_at + strlen( $this->chunk );
			if ( ! $in_chunk ) {
				// The first read is small (headers). A read that goes on gets 1 MB at a time.
				// A prefix that already holds the start is not that first read.
				$at    = $this->pos;
				$fresh = $this->chunk_at < 0 && ! ( self::$prefix_key === $this->key && '' !== self::$prefix_buf );
				$len   = $fresh ? 65536 : self::CHUNK;
				$r   = self::call( array( 'op' => 'get', 'key' => $this->key, 'offset' => $at, 'length' => min( $len, $this->size - $at ) ) );
				if ( ! $r || ! $r['found'] ) {
					return $out;
				}
				$this->chunk    = base64_decode( $r['body'] );
				$this->chunk_at = $at;
				// A hole does not merge. Only a range that continues from offset 0 is kept.
				self::prefix_note( $this->key, $at, $this->chunk );
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
		// '' is the stream root. 'uploads' is the media mount: the upload_dir
		// filter maps WP_CONTENT_DIR/uploads onto r2://uploads. Both are
		// directories even when the bucket has no object under them.
		//
		// wp_mkdir_p walks dirname() until is_dir() is true, then chmod()s each
		// new component. dirname('r2://uploads') is 'r2:', then '.'. On the wasm
		// filesystem that directory is mode 0777, outside umask 022, so chmod()
		// runs on plain paths such as './://uploads/YYYY/MM'. Those paths are
		// not on this stream and do not exist, so PHP prints
		// "chmod(): No such file or directory" before the REST JSON (#594).
		if ( '' === $key || 'uploads' === $key || isset( self::$dirs[ $key ] ) ) {
			return self::stat_array( true );
		}
		$hit = self::stat_cached( $key );
		if ( is_array( $hit ) ) {
			if ( self::tracing() ) {
				++self::$trace_cached;
			}
			if ( 'absent' === $hit['t'] ) {
				if ( ! ( $flags & STREAM_URL_STAT_QUIET ) ) {
					trigger_error( 'r2 file not found: ' . $key, E_USER_NOTICE );
				}
				return false;
			}
			if ( 'dir' === $hit['t'] ) {
				return self::stat_array( true );
			}
			return self::stat_array( false, (int) ( $hit['size'] ?? 0 ), (int) ( $hit['mtime'] ?? 0 ) );
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
		$key = self::key( $uri );
		$ok  = null !== self::call( array( 'op' => 'delete', 'key' => $key ) );
		if ( $ok ) {
			self::release_fallback( $key );
		}
		return $ok;
	}

	public function rename( $from, $to ) {
		// The Worker copies inside R2. The bytes do not pass through PHP.
		$from_key = self::key( $from );
		$r        = self::call( array( 'op' => 'copy', 'from' => $from_key, 'to' => self::key( $to ), 'type' => self::content_type( $to ), 'move' => true ) );
		if ( $r && $r['found'] ) {
			self::release_fallback( $from_key );
			return true;
		}
		return false;
	}

	/** The C1 fallback row. The worker table _r2_reserved is separate. */
	public static function reserved_option( $key ) {
		return '_r2_reserved_' . md5( (string) $key );
	}

	/** Drop the fallback row when the file is gone. Issue #946. */
	private static function release_fallback( $key ) {
		global $wpdb;
		if ( ! is_object( $wpdb ) || empty( $wpdb->options ) || ! method_exists( $wpdb, 'query' ) ) {
			return;
		}
		$wpdb->query( $wpdb->prepare( 'DELETE FROM `' . $wpdb->options . '` WHERE option_name = %s', self::reserved_option( $key ) ) );
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
		// A later scandir reuses the page only when truncated was boolean false.
		if ( ! empty( self::$list_complete[ $prefix ] ) ) {
			if ( self::tracing() ) {
				++self::$trace_cached;
			}
			$this->entries = array_map( 'strval', array_keys( isset( self::$list_children[ $prefix ] ) ? self::$list_children[ $prefix ] : array() ) );
			return true;
		}
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

// The runtime serves later requests. Arm the clear on each include. call() arms it again after a clear.
R2_Uploads_Stream::arm_request_clear();

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
// Delete and rename release that name (issue #946). The next upload can use it.
// WordPress 7.1 adds its own filter at priority 10 during a sub-size
// sideload, after this file loads. That filter drops the extra -1 that
// wp_unique_filename() added. This filter runs later, so the reserved
// name is the name WordPress saves (issue #952).
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
				// local database). One INSERT IGNORE on the unique option_name:
				// the database lets exactly one request insert the row. Not
				// add_option(): it checks get_option() first (with a persistent
				// object cache, a shared and possibly stale answer), then runs
				// INSERT ... ON DUPLICATE KEY UPDATE, which reports a change on a
				// duplicate too. With the APCu cache, 8 parallel uploads of one
				// name gave 7 files in 2 of 5 runs of tests/break.py (2026-11-05).
				// The file must also not exist in R2.
				global $wpdb;
				// Approach A has no reserve row. This head always hits the bridge.
				// A cached absent value must not skip it.
				$h = R2_Uploads_Stream::call( array( 'op' => 'head', 'key' => $key, 'bridge' => true ) );
				$r = array(
					'reserved' => ( ! $h || empty( $h['found'] ) )
						&& 1 === $wpdb->query( $wpdb->prepare( "INSERT IGNORE INTO `$wpdb->options` (`option_name`, `option_value`, `autoload`) VALUES (%s, %s, 'off')", R2_Uploads_Stream::reserved_option( $key ), (string) time() ) ),
				);
			}
			if ( $r['reserved'] ) {
				return $name;
			}
			$name = $base . '-' . $i . $ext;
		}
		return $filename;
	},
	100,
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

// WooCommerce's force download (WC_Download_Handler::parse_file_path) maps a file URL under the uploads baseurl to
// the basedir, which is r2://uploads here, then keeps only the parsed PATH for a scheme that is not http, https or
// ftp: the buyer's file becomes "/woocommerce_uploads/<f>", which opens nothing ("File not found"). This filter runs
// at the end of parse_file_path, so only after download() has checked the buyer's order, key and limits. It gives
// a local path back its r2:// form when that file is not on the local filesystem and IS in R2. A remote file, an
// existing local file, a path with a ".." segment, or a path that is in neither place is returned unchanged.
// Tested in tests/wc-download-path-test.php.
add_filter(
	'woocommerce_download_parse_file_path',
	function ( $file_path, $remote_file = false ) {
		if ( $remote_file || ! is_string( $file_path ) || '' === $file_path || '/' !== $file_path[0] ) {
			return $file_path;
		}
		if ( preg_match( '#(^|/)\.\.(/|$)#', $file_path ) || @file_exists( $file_path ) ) {
			return $file_path;
		}
		$r2 = 'r2://uploads' . $file_path;
		return @file_exists( $r2 ) ? $r2 : $file_path;
	},
	10,
	2
);
