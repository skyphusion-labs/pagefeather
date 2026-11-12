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
	/**
	 * @var array<string, string> Per-group salt. A group with a non-empty salt is
	 * persistent across requests and its persistent key carries the salt, so a change
	 * of inputs (a new salt) reads as a miss and never serves a stale value.
	 * @see set_group_salt().
	 */
	private $group_salt = array();
	/** @var array<string, bool> */
	private $global_groups = array();
	private $blog_prefix = '';
	public $cache_hits = 0;
	public $cache_misses = 0;
	public $bridge_calls = 0;
	/** @var array<string,bool>|null Approach-A persist allowlist (#218); null means the default (b-dosql) posture. */
	private $persist_allow = null;
	/** @var int Default expire (seconds) for a persistent set in approach-A isolated mode; 0 means none. */
	private $default_ttl = 0;
	/** @var bool Force the cache off this request (spike-gated x-oc-off), for a clean same-binary bracket. */
	private $force_off = false;
	/**
	 * @var array<string,bool> Groups under exact invalidation (#296 slice 1): JS_OBJECT_CACHE_VERSIONED.
	 * Each persists under its version from <prefix>skyph_cache_versions as its group salt.
	 */
	private $versioned = array();
	/** @var array<string,int>|null The versions, read once per request on first use; null before. */
	private $versions = null;
	/** @var int Version reads this request (0 or 1), for x-oc-stats. */
	public $version_reads = 0;

	public function __construct() {
		$this->blog_prefix = is_multisite() ? get_current_blog_id() . ':' : '';
		// Approach A, many isolates (#218): persist only an allowlist of cross-isolate-safe
		// groups, cap staleness with a bounded TTL, and honor a spike-gated per-request
		// x-oc-off so the measurement can bracket the same binary. b-dosql defines none of
		// these constants, so its posture is unchanged.
		if ( defined( 'JS_OBJECT_CACHE_PERSIST_GROUPS' ) ) {
			$this->persist_allow = array();
			foreach ( explode( ',', (string) JS_OBJECT_CACHE_PERSIST_GROUPS ) as $g ) {
				$g = trim( $g );
				if ( '' !== $g ) {
					$this->persist_allow[ $g ] = true;
				}
			}
		}
		$this->default_ttl = defined( 'JS_OBJECT_CACHE_TTL' ) ? (int) JS_OBJECT_CACHE_TTL : 0;
		$this->force_off   = ! empty( $_SERVER['HTTP_X_OC_OFF'] );
		if ( defined( 'JS_OBJECT_CACHE_VERSIONED' ) ) {
			foreach ( explode( ',', (string) JS_OBJECT_CACHE_VERSIONED ) as $g ) {
				$g = trim( $g );
				if ( '' !== $g ) {
					$this->versioned[ $g ] = true;
				}
			}
		}
	}

	/**
	 * Before the first read or write of a versioned group this request: read every version ONCE
	 * (a request-start snapshot) and make each versioned group's salt its version. A version bump
	 * (a trigger, in the same statement as the write) changes every key of the group at once, in
	 * every isolate's Map and in L2. No table or no row: the group keeps its unversioned posture.
	 */
	private function version_gate( $group ) {
		if ( null !== $this->versions || ! isset( $this->versioned[ $group ] ) || $this->force_off ) {
			return;
		}
		$this->versions = array();
		global $wpdb;
		if ( ! isset( $wpdb ) || ! is_object( $wpdb ) || ! method_exists( $wpdb, 'get_results' ) ) {
			return;
		}
		$quiet = method_exists( $wpdb, 'suppress_errors' ) ? $wpdb->suppress_errors( true ) : null;
		$rows  = $wpdb->get_results( 'SELECT grp, v FROM ' . $wpdb->prefix . 'skyph_cache_versions', ARRAY_N );
		if ( null !== $quiet ) {
			$wpdb->suppress_errors( $quiet );
		}
		++$this->version_reads;
		foreach ( (array) $rows as $row ) {
			if ( is_array( $row ) && isset( $row[0], $row[1], $this->versioned[ $row[0] ] ) ) {
				$this->versions[ $row[0] ] = (int) $row[1];
				$this->set_group_salt( $row[0], 'v' . (int) $row[1] );
			}
		}
	}

	private function call( array $op ) {
		++$this->bridge_calls;
		$reply = json_decode( post_message_to_js( json_encode( array( 'oc' => $op ) ) ), true );
		return is_array( $reply ) ? $reply : array();
	}

	private function persistent( $group ) {
		if ( $this->force_off ) {
			return false;
		}
		if ( isset( $this->group_salt[ $group ] ) && '' !== $this->group_salt[ $group ] ) {
			return true;
		}
		// Approach A isolated mode: ONLY allowlisted groups (or a salted group) persist
		// across requests; everything else, above all the WooCommerce correctness groups,
		// stays per request, so a stale read in one isolate Map after another isolate write
		// cannot happen. b-dosql leaves persist_allow null and keeps the default posture.
		if ( null !== $this->persist_allow ) {
			return isset( $this->persist_allow[ $group ] );
		}
		return empty( $this->non_persistent[ $group ] );
	}

	private function pkey( $key, $group ) {
		$prefix = isset( $this->global_groups[ $group ] ) ? '' : $this->blog_prefix;
		$salt   = ( isset( $this->group_salt[ $group ] ) && '' !== $this->group_salt[ $group ] ) ? $this->group_salt[ $group ] . "\0" : '';
		return $group . "\0" . $salt . $prefix . $key;
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
			$this->non_persistent[ $g ] = true;
		}
	}

	/**
	 * Make a group persistent across requests under a validity salt, or clear it.
	 *
	 * A salted group is persistent even when core marked it non-persistent, and its
	 * persistent key carries the salt. The salt is a fingerprint of every input the
	 * group's values are built from: a change of any input is a new salt, so the old
	 * values are never read again (invalidation by key, with no delete). A caller
	 * that cannot compute a safe salt passes '' (or null) and the group stays per
	 * request, exactly as core marked it. Used by the theme.json cache across
	 * requests (mu-plugins/theme-json-cache.php, issue #49).
	 *
	 * @param string      $group The cache group.
	 * @param string|null $salt  The validity salt, or '' / null to leave the group per request.
	 */
	public function set_group_salt( $group, $salt ) {
		$salt = ( null === $salt ) ? '' : (string) $salt;
		$old  = isset( $this->group_salt[ $group ] ) ? $this->group_salt[ $group ] : '';
		if ( $salt !== $old ) {
			// A different salt means different inputs: drop this request's view of the group so the next read reloads under the new salt.
			unset( $this->cache[ $group ], $this->missing[ $group ] );
		}
		$this->group_salt[ $group ] = $salt;
	}

	public function switch_to_blog( $blog_id ) {
		$this->blog_prefix = is_multisite() ? (int) $blog_id . ':' : '';
	}

	private function has_local( $key, $group ) {
		return isset( $this->cache[ $group ] ) && array_key_exists( $key, $this->cache[ $group ] );
	}

	public function get( $key, $group = 'default', $force = false, &$found = null ) {
		$this->version_gate( $group );
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
		$this->version_gate( $group );
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
		$this->version_gate( $group );
		$this->cache[ $group ][ $key ] = self::copy( $data );
		unset( $this->missing[ $group ][ $key ] );
		if ( $this->persistent( $group ) ) {
			if ( 0 === (int) $expire && $this->default_ttl > 0 ) {
				$expire = $this->default_ttl;
			}
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
		$this->version_gate( $group );
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
