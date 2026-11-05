<?php
/**
 * The object cache across requests, loaded by object-cache.php when
 * JS_OBJECT_CACHE is defined. See object-cache.php.
 */

class JS_Object_Cache {
	/** @var array<string, array<string, mixed>> Values of this request, by group. */
	private $cache = array();
	/** @var array<string, array<string, bool>> Keys known to be missing in the Map, this request. */
	private $missing = array();
	/** @var array<string, bool> */
	private $non_persistent = array();
	/** @var array<string, bool> */
	private $global_groups = array();
	private $blog_prefix = '';
	public $cache_hits = 0;
	public $cache_misses = 0;
	public $bridge_calls = 0;

	public function __construct() {
		$this->blog_prefix = is_multisite() ? get_current_blog_id() . ':' : '';
	}

	private function call( array $op ) {
		++$this->bridge_calls;
		$reply = json_decode( post_message_to_js( json_encode( array( 'oc' => $op ) ) ), true );
		return is_array( $reply ) ? $reply : array();
	}

	private function persistent( $group ) {
		return empty( $this->non_persistent[ $group ] );
	}

	private function pkey( $key, $group ) {
		$prefix = isset( $this->global_groups[ $group ] ) ? '' : $this->blog_prefix;
		return $group . "\0" . $prefix . $key;
	}

	private static function copy( $value ) {
		return is_object( $value ) ? clone $value : $value;
	}

	public function add_global_groups( $groups ) {
		foreach ( (array) $groups as $g ) {
			$this->global_groups[ $g ] = true;
		}
	}

	public function add_non_persistent_groups( $groups ) {
		foreach ( (array) $groups as $g ) {
			if ( 'theme_json' !== $g ) {
				$this->non_persistent[ $g ] = true;
			}
		}
	}

	public function switch_to_blog( $blog_id ) {
		$this->blog_prefix = is_multisite() ? (int) $blog_id . ':' : '';
	}

	private function has_local( $key, $group ) {
		return isset( $this->cache[ $group ] ) && array_key_exists( $key, $this->cache[ $group ] );
	}

	public function get( $key, $group = 'default', $force = false, &$found = null ) {
		if ( $this->has_local( $key, $group ) && ! $force ) {
			$found = true;
			++$this->cache_hits;
			return self::copy( $this->cache[ $group ][ $key ] );
		}
		if ( $this->persistent( $group ) && empty( $this->missing[ $group ][ $key ] ) ) {
			$r = $this->call( array( 'op' => 'get', 'k' => array( $this->pkey( $key, $group ) ) ) );
			if ( isset( $r['v'][0] ) && null !== $r['v'][0] ) {
				$value                          = unserialize( base64_decode( $r['v'][0] ) );
				$this->cache[ $group ][ $key ] = $value;
				$found                          = true;
				++$this->cache_hits;
				return self::copy( $value );
			}
			$this->missing[ $group ][ $key ] = true;
		}
		$found = false;
		++$this->cache_misses;
		return false;
	}

	public function get_multiple( $keys, $group = 'default', $force = false ) {
		$out  = array();
		$need = array();
		foreach ( $keys as $key ) {
			if ( $this->has_local( $key, $group ) && ! $force ) {
				$out[ $key ] = self::copy( $this->cache[ $group ][ $key ] );
				++$this->cache_hits;
			} elseif ( $this->persistent( $group ) && empty( $this->missing[ $group ][ $key ] ) ) {
				$need[] = $key;
			} else {
				$out[ $key ] = false;
				++$this->cache_misses;
			}
		}
		if ( $need ) {
			$r = $this->call( array( 'op' => 'get', 'k' => array_map( function ( $k ) use ( $group ) { return $this->pkey( $k, $group ); }, $need ) ) );
			foreach ( $need as $i => $key ) {
				if ( isset( $r['v'][ $i ] ) && null !== $r['v'][ $i ] ) {
					$value                          = unserialize( base64_decode( $r['v'][ $i ] ) );
					$this->cache[ $group ][ $key ] = $value;
					$out[ $key ]                    = self::copy( $value );
					++$this->cache_hits;
				} else {
					$this->missing[ $group ][ $key ] = true;
					$out[ $key ]                      = false;
					++$this->cache_misses;
				}
			}
		}
		$sorted = array();
		foreach ( $keys as $key ) {
			$sorted[ $key ] = $out[ $key ];
		}
		return $sorted;
	}

	public function set( $key, $data, $group = 'default', $expire = 0 ) {
		$this->cache[ $group ][ $key ] = self::copy( $data );
		unset( $this->missing[ $group ][ $key ] );
		if ( $this->persistent( $group ) ) {
			$this->call( array( 'op' => 'set', 'k' => $this->pkey( $key, $group ), 'v' => base64_encode( serialize( $data ) ), 'ttl' => (int) $expire ) );
		}
		return true;
	}

	public function set_multiple( array $data, $group = 'default', $expire = 0 ) {
		$out = array();
		foreach ( $data as $key => $value ) {
			$out[ $key ] = $this->set( $key, $value, $group, $expire );
		}
		return $out;
	}

	public function add( $key, $data, $group = 'default', $expire = 0 ) {
		if ( wp_suspend_cache_addition() ) {
			return false;
		}
		$found = false;
		$this->get( $key, $group, false, $found );
		return $found ? false : $this->set( $key, $data, $group, $expire );
	}

	public function add_multiple( array $data, $group = 'default', $expire = 0 ) {
		$out = array();
		foreach ( $data as $key => $value ) {
			$out[ $key ] = $this->add( $key, $value, $group, $expire );
		}
		return $out;
	}

	public function replace( $key, $data, $group = 'default', $expire = 0 ) {
		$found = false;
		$this->get( $key, $group, false, $found );
		return $found ? $this->set( $key, $data, $group, $expire ) : false;
	}

	public function delete( $key, $group = 'default' ) {
		$had = $this->has_local( $key, $group );
		unset( $this->cache[ $group ][ $key ] );
		$this->missing[ $group ][ $key ] = true;
		if ( $this->persistent( $group ) ) {
			$r = $this->call( array( 'op' => 'del', 'k' => array( $this->pkey( $key, $group ) ) ) );
			return $had || ! empty( $r['n'] );
		}
		return $had;
	}

	public function delete_multiple( array $keys, $group = 'default' ) {
		$out = array();
		foreach ( $keys as $key ) {
			$out[ $key ] = $this->delete( $key, $group );
		}
		return $out;
	}

	public function incr( $key, $offset = 1, $group = 'default' ) {
		$found = false;
		$value = $this->get( $key, $group, false, $found );
		if ( ! $found ) {
			return false;
		}
		$value = max( 0, ( is_numeric( $value ) ? (int) $value : 0 ) + (int) $offset );
		$this->set( $key, $value, $group );
		return $value;
	}

	public function decr( $key, $offset = 1, $group = 'default' ) {
		return $this->incr( $key, -(int) $offset, $group );
	}

	public function flush() {
		$this->cache   = array();
		$this->missing = array();
		$this->call( array( 'op' => 'flush' ) );
		return true;
	}

	public function flush_runtime() {
		$this->cache   = array();
		$this->missing = array();
		return true;
	}

	public function flush_group( $group ) {
		unset( $this->cache[ $group ], $this->missing[ $group ] );
		$this->call( array( 'op' => 'flush_group', 'g' => $group . "\0" ) );
		return true;
	}

	public function stats() {
		echo '<p>Hits: ' . (int) $this->cache_hits . ', misses: ' . (int) $this->cache_misses . ', bridge calls: ' . (int) $this->bridge_calls . '</p>';
	}
}

function wp_cache_init() {
	$GLOBALS['wp_object_cache'] = new JS_Object_Cache();
}
function wp_cache_add( $key, $data, $group = '', $expire = 0 ) {
	return $GLOBALS['wp_object_cache']->add( $key, $data, $group ?: 'default', (int) $expire );
}
function wp_cache_add_multiple( array $data, $group = '', $expire = 0 ) {
	return $GLOBALS['wp_object_cache']->add_multiple( $data, $group ?: 'default', (int) $expire );
}
function wp_cache_replace( $key, $data, $group = '', $expire = 0 ) {
	return $GLOBALS['wp_object_cache']->replace( $key, $data, $group ?: 'default', (int) $expire );
}
function wp_cache_set( $key, $data, $group = '', $expire = 0 ) {
	return $GLOBALS['wp_object_cache']->set( $key, $data, $group ?: 'default', (int) $expire );
}
function wp_cache_set_multiple( array $data, $group = '', $expire = 0 ) {
	return $GLOBALS['wp_object_cache']->set_multiple( $data, $group ?: 'default', (int) $expire );
}
function wp_cache_get( $key, $group = '', $force = false, &$found = null ) {
	return $GLOBALS['wp_object_cache']->get( $key, $group ?: 'default', $force, $found );
}
function wp_cache_get_multiple( $keys, $group = '', $force = false ) {
	return $GLOBALS['wp_object_cache']->get_multiple( $keys, $group ?: 'default', $force );
}
function wp_cache_delete( $key, $group = '' ) {
	return $GLOBALS['wp_object_cache']->delete( $key, $group ?: 'default' );
}
function wp_cache_delete_multiple( array $keys, $group = '' ) {
	return $GLOBALS['wp_object_cache']->delete_multiple( $keys, $group ?: 'default' );
}
function wp_cache_incr( $key, $offset = 1, $group = '' ) {
	return $GLOBALS['wp_object_cache']->incr( $key, $offset, $group ?: 'default' );
}
function wp_cache_decr( $key, $offset = 1, $group = '' ) {
	return $GLOBALS['wp_object_cache']->decr( $key, $offset, $group ?: 'default' );
}
function wp_cache_flush() {
	return $GLOBALS['wp_object_cache']->flush();
}
function wp_cache_flush_runtime() {
	return $GLOBALS['wp_object_cache']->flush_runtime();
}
function wp_cache_flush_group( $group ) {
	return $GLOBALS['wp_object_cache']->flush_group( $group );
}
function wp_cache_supports( $feature ) {
	return in_array( $feature, array( 'add_multiple', 'set_multiple', 'get_multiple', 'delete_multiple', 'flush_runtime', 'flush_group' ), true );
}
function wp_cache_close() {
	return true;
}
function wp_cache_add_global_groups( $groups ) {
	$GLOBALS['wp_object_cache']->add_global_groups( $groups );
}
function wp_cache_add_non_persistent_groups( $groups ) {
	$GLOBALS['wp_object_cache']->add_non_persistent_groups( $groups );
}
function wp_cache_switch_to_blog( $blog_id ) {
	$GLOBALS['wp_object_cache']->switch_to_blog( $blog_id );
}
function wp_cache_reset() {
	_deprecated_function( __FUNCTION__, '3.5.0', 'wp_cache_switch_to_blog()' );
	$GLOBALS['wp_object_cache']->flush_runtime();
}
