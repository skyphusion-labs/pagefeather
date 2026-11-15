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
	 * @var array<string,bool> Groups under exact invalidation (#296 (2)): JS_OBJECT_CACHE_VERSIONED.
	 * Each persists across requests under its version from <prefix>skyph_cache_versions, as its salt.
	 */
	private $versioned = array();
	/** @var array<string,int>|null The versions, read once per request on first use; null before. */
	private $versions = null;
	/** @var int Version reads this request (0 or 1), for x-oc-stats. */
	public $version_reads = 0;
	/**
	 * @var array<string,bool> Versioned groups whose keys are BUCKETED (#296 (2), the transient half): each
	 * key hashes into one of TRANSIENT_BUCKETS version rows (tb0..), and a set or delete bumps its bucket
	 * in the database first. Transients: with this cache on, WordPress keeps them only here.
	 */
	private $bucketed = array();
	/** @var bool Every bucket row was read this request (no row missing): bucketed groups may persist. */
	private $buckets_ok = false;
	/** @var int Bucket bumps this request, for x-oc-stats. */
	public $bucket_bumps = 0;
	/**
	 * @var array<string,array<string,bool>> Bucketed keys this request found ABSENT in the shared store (#643 probe (b),
	 * the bump cascade): a set of such a key is a regeneration, and bumps only if a re-check finds a value written meanwhile.
	 */
	private $absent = array();
	const TRANSIENT_BUCKETS = 64;

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
		// #491: `options` NEVER persists across requests on approach A, even when the allowlist names
		// it. WordPress keeps every autoloaded option in one key, alloptions, so an isolate that reads it
		// stale (its own Map, or KV) shows old values, and a form saved from that page writes them back:
		// a lost update (measured on wp-a-lean: alloptions stale in 7 of 20 reads right after a write).
		// Options are then read from MySQL once per request (alloptions is one query).
		if ( null !== $this->persist_allow ) {
			unset( $this->persist_allow['options'] );
		}
		$this->default_ttl = defined( 'JS_OBJECT_CACHE_TTL' ) ? (int) JS_OBJECT_CACHE_TTL : 0;
		$this->force_off   = ! empty( $_SERVER['HTTP_X_OC_OFF'] );
		if ( defined( 'JS_OBJECT_CACHE_VERSIONED' ) ) {
			foreach ( explode( ',', (string) JS_OBJECT_CACHE_VERSIONED ) as $g ) {
				$g = trim( $g );
				if ( '' !== $g ) {
					$this->versioned[ $g ] = true;
					if ( 'transient' === $g || 'site-transient' === $g ) {
						$this->bucketed[ $g ] = true;
					}
				}
			}
		}
	}

	/**
	 * #643 live check: wp_prime_option_caches() (core) looks up every listed option by key, also the ones in
	 * alloptions or notoptions, and never writes those alone, so they miss in any persistent cache. Answer them as
	 * misses here, with no bridge call (49 gets, 39 KV misses and 0.84 sets per request were measured). Core uses
	 * alloptions or notoptions for them anyway. Approach A, versioned options only.
	 */
	private function options_known_miss( $key, $group ) {
		if ( 'options' !== $group || ! isset( $this->versions['options'] ) || 'alloptions' === $key || 'notoptions' === $key ) {
			return false;
		}
		$all = isset( $this->cache['options']['alloptions'] ) ? $this->cache['options']['alloptions'] : null;
		$not = isset( $this->cache['options']['notoptions'] ) ? $this->cache['options']['notoptions'] : null;
		return ( is_array( $all ) && array_key_exists( $key, $all ) ) || ( is_array( $not ) && isset( $not[ $key ] ) );
	}

	/** The version row of a bucketed key: tb0 .. tb63. */
	private static function bucket( $key ) {
		return 'tb' . ( abs( crc32( (string) $key ) ) % self::TRANSIENT_BUCKETS );
	}

	/**
	 * True when this request found the key ABSENT in the shared store and it is STILL absent there (the safe
	 * re-check): writing it is a regeneration, not an overwrite. Clears the flag either way.
	 */
	private function is_regeneration( $key, $group, $pkey, $data = null, $has_data = false ) {
		if ( empty( $this->absent[ $group ][ $key ] ) ) {
			return false;
		}
		unset( $this->absent[ $group ][ $key ] );
		$op = array( 'op' => 'get', 'k' => array( $pkey ) );
		if ( $has_data ) {
			// #296 (b) probe, measure only: the JS side counts whether a found value equals the one about to be written.
			$op['cmp'] = base64_encode( serialize( $data ) );
		}
		$r = $this->call( $op );
		return ! ( isset( $r['v'][0] ) && null !== $r['v'][0] );
	}

	/**
	 * Bump a bucketed key's version in the database, then read it back, BEFORE its new value is written: the
	 * value then goes under the new version, and every isolate's next request asks for that key. False when
	 * the bump did not land: the caller must not write to the shared store (an old version could be served).
	 */
	private function bump_bucket( $key ) {
		global $wpdb;
		$b = self::bucket( $key );
		if ( ! $this->buckets_ok || ! isset( $wpdb ) || ! is_object( $wpdb ) || ! method_exists( $wpdb, 'query' ) || ! method_exists( $wpdb, 'get_var' ) ) {
			return false;
		}
		$t     = $wpdb->prefix . 'skyph_cache_versions';
		$quiet = method_exists( $wpdb, 'suppress_errors' ) ? $wpdb->suppress_errors( true ) : null;
		$ok    = $wpdb->query( "UPDATE {$t} SET v = v + 1 WHERE grp = '{$b}'" );
		$v     = $ok ? $wpdb->get_var( "SELECT v FROM {$t} WHERE grp = '{$b}'" ) : null;
		if ( null !== $quiet ) {
			$wpdb->suppress_errors( $quiet );
		}
		if ( ! $ok || ! is_numeric( $v ) ) {
			// Fail closed: bucketed groups stop persisting for the rest of this request.
			$this->buckets_ok = false;
			return false;
		}
		$this->versions[ $b ] = (int) $v;
		++$this->bucket_bumps;
		return true;
	}

	/**
	 * #296 (2): before the first read or write of a versioned group this request, read every version
	 * ONCE (a request-start snapshot) and make each versioned group's salt its version. A bump (an AFTER
	 * trigger on wp_options, in the same statement as the write; cache-versions.mjs) changes every key
	 * of the group at once, in every isolate's Map and in L2, so a lagging store can only answer a key
	 * nobody asks for any more. No table, no row or an error: the group keeps its unversioned posture
	 * (for options on approach A, #491: per request only).
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
		$buckets = 0;
		foreach ( (array) $rows as $row ) {
			if ( ! is_array( $row ) || ! isset( $row[0], $row[1] ) || ! is_numeric( $row[1] ) ) {
				continue;
			}
			if ( isset( $this->versioned[ $row[0] ] ) && ! isset( $this->bucketed[ $row[0] ] ) ) {
				$this->versions[ $row[0] ] = (int) $row[1];
				$this->set_group_salt( $row[0], 'v' . (int) $row[1] );
			} elseif ( preg_match( '/^tb([0-9]+)$/', $row[0], $m ) && (int) $m[1] < self::TRANSIENT_BUCKETS ) {
				$this->versions[ $row[0] ] = (int) $row[1];
				++$buckets;
			}
		}
		// Every bucket row must be there, or a key could fall in a missing one: then nothing bucketed persists.
		$this->buckets_ok = ( self::TRANSIENT_BUCKETS === $buckets );
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
		// #491: on approach A, options stay per request whatever else says, UNLESS this request read
		// an exact options version (#296 (2)): then a write anywhere moves every options key at once.
		if ( null !== $this->persist_allow && 'options' === $group ) {
			return isset( $this->versions['options'] );
		}
		// #296 (2): a bucketed group (transients) persists only with every bucket version read this request.
		if ( isset( $this->bucketed[ $group ] ) ) {
			return $this->buckets_ok;
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
		if ( isset( $this->bucketed[ $group ] ) ) {
			$b    = self::bucket( $key );
			$salt = $b . 'v' . ( isset( $this->versions[ $b ] ) ? (int) $this->versions[ $b ] : 0 ) . "\0";
		}
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
		if ( $this->persistent( $group ) && empty( $this->missing[ $group ][ $key ] ) && ! $this->options_known_miss( $key, $group ) ) {
			$r = $this->call( array( 'op' => 'get', 'k' => array( $this->pkey( $key, $group ) ) ) );
			if ( isset( $r['v'][0] ) && null !== $r['v'][0] ) {
				$value                          = unserialize( base64_decode( $r['v'][0] ) );
				$this->cache[ $group ][ $key ] = $value;
				$found                          = true;
				++$this->cache_hits;
				unset( $this->absent[ $group ][ $key ] );
				return self::copy( $value );
			}
			$this->missing[ $group ][ $key ] = true;
			if ( isset( $this->bucketed[ $group ] ) ) {
				$this->absent[ $group ][ $key ] = true;
			}
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
			} elseif ( $this->persistent( $group ) && empty( $this->missing[ $group ][ $key ] ) && ! $this->options_known_miss( $key, $group ) ) {
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
					unset( $this->absent[ $group ][ $key ] );
				} else {
					$this->missing[ $group ][ $key ] = true;
					if ( isset( $this->bucketed[ $group ] ) ) {
						$this->absent[ $group ][ $key ] = true;
					}
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
		// #296 (b) probe v2, measure only: does the new value equal the copy this request held (SERIALIZED, never identity)?
		$pc = null;
		if ( isset( $this->bucketed[ $group ] ) ) {
			$pc = $this->has_local( $key, $group ) ? ( serialize( $this->cache[ $group ][ $key ] ) === serialize( $data ) ? 'eq' : 'ne' ) : 'nolocal';
		}
		$this->cache[ $group ][ $key ] = self::copy( $data );
		unset( $this->missing[ $group ][ $key ] );
		// A bucketed set moves its bucket first, then writes under the new version; a bump that did not land
		// writes nothing to the shared store (this request keeps its own value locally).
		if ( isset( $this->bucketed[ $group ] ) && $this->persistent( $group ) ) {
			$old = $this->pkey( $key, $group );
			// #643 probe (b), the bump cascade: a set of a key this request found ABSENT is a regeneration. Nobody can
			// hold a value for it under this version, so it does not bump, unless the safe re-check (ruled 2026-11-15:
			// one shared-store read) finds a value another isolate wrote meanwhile; then it is an overwrite and bumps.
			if ( $this->is_regeneration( $key, $group, $old, $data, true ) ) {
				$old = null;
				$pc  = 'regen';
			} elseif ( ! $this->bump_bucket( $key ) ) {
				// The version did not move, so every isolate still asks for the old key: drop its old value
				// (best effort: another isolate's Map keeps a copy up to its TTL).
				$this->call( array( 'op' => 'del', 'k' => array( $old ) ) );
				return true;
			}
		}
		if ( $this->persistent( $group ) ) {
			if ( 0 === (int) $expire && $this->default_ttl > 0 ) {
				$expire = $this->default_ttl;
			}
			$op = array( 'op' => 'set', 'k' => $this->pkey( $key, $group ), 'v' => base64_encode( serialize( $data ) ), 'ttl' => (int) $expire );
			if ( null !== $pc ) {
				$op['pc'] = $pc; // #296 (b) probe v2
			}
			$this->call( $op );
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
		// A bucketed delete moves its bucket: every isolate's next request misses the key.
		if ( isset( $this->bucketed[ $group ] ) && $this->persistent( $group ) ) {
			$old = $this->pkey( $key, $group );
			// A delete of a key found absent, and still absent on re-check, has nothing to invalidate.
			if ( $this->is_regeneration( $key, $group, $old ) ) {
				return $had;
			}
			if ( ! $this->bump_bucket( $key ) ) {
				$this->call( array( 'op' => 'del', 'k' => array( $old ) ) );
			} else {
				$this->call( array( 'op' => 'count', 'k' => $old, 'f' => 'del_bump' ) ); // #296 (b) probe v2, measure only
			}
			return $had;
		}
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
