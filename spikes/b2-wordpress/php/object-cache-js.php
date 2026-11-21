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
		// #1199: learn this request's transient names at shutdown (one autoloaded list, read with alloptions).
		if ( function_exists( 'add_action' ) ) {
			add_action( 'shutdown', array( $this, 'transient_learn' ), 1 );
			// #1210 lever 2: every statement passes the query filter (wpdb, Hyperdrive_WPDB, the SQLite driver); a write to a
			// shadowed table clears its shadows (shadow_guard).
			add_filter( 'query', array( $this, 'shadow_guard' ), PHP_INT_MAX );
			// #1210: the request's transient deletes land in one statement at its end (transient_flush).
			add_action( 'shutdown', array( $this, 'transient_flush' ), PHP_INT_MAX );
		}
		// #1210: and on every other way a request ends (a fatal error, an exit before WordPress's shutdown hook). This
		// function runs with the other shutdown functions, in their order, and registers the flush again, so it runs
		// after all of them, the shutdown action's handlers included. The flush is idempotent.
		$self = $this;
		register_shutdown_function(
			static function () use ( $self ) {
				register_shutdown_function( array( $self, 'transient_flush' ) );
			}
		);
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
		foreach ( (array) $rows as $row ) {
			if ( is_array( $row ) && isset( $row[0], $row[1], $this->versioned[ $row[0] ] ) && is_numeric( $row[1] ) ) {
				$this->versions[ $row[0] ] = (int) $row[1];
				$this->set_group_salt( $row[0], 'v' . (int) $row[1] );
			}
		}
		// #734: the var is on but no version was read (no versions table, or no row): the groups stay per request,
		// which is safe, but the default does nothing. Tell the Worker (once per request) so it logs it once per isolate
		// and deploy/doctor can warn.
		if ( empty( $this->versions ) ) {
			$this->call( array( 'op' => 'vmiss' ) );
		}
	}

	private function call( array $op ) {
		++$this->bridge_calls;
		$reply = json_decode( post_message_to_js( json_encode( array( 'oc' => $op ) ) ), true );
		return is_array( $reply ) ? $reply : array();
	}

	/**
	 * #1199: transients are DURABLE. With this drop-in loaded, wp_using_ext_object_cache() is true, so core keeps
	 * transients ONLY in the object cache (set_transient() -> wp_cache_set( ..., 'transient' )). Approach A persists
	 * only an allowlist across requests, so a transient died with its request (a permalink save lost its notice); on
	 * b-dosql it lived in the object's Map and died with the object. These groups are stored as core stores them with
	 * no external cache: option rows _transient_<name> and _transient_timeout_<name> (_site_transient_* for the
	 * site-transient group), through the option API, so the database is the one store, never the cross-request cache.
	 * While WordPress installs (no tables yet) they stay per request, as before.
	 */
	private static function durable( $group ) {
		return ( 'transient' === $group || 'site-transient' === $group ) && function_exists( 'skyphusion_transient_rows' ) && ! ( function_exists( 'wp_installing' ) && wp_installing() );
	}

	private static function now() {
		return defined( 'SKYPHUSION_TRANSIENT_CLOCK' ) ? (int) call_user_func( SKYPHUSION_TRANSIENT_CLOCK ) : time();
	}

	/** @return array{0:string,1:string} the value row and the timeout row, core's names. */
	private static function durable_names( $key, $group ) {
		$p = 'site-transient' === $group ? '_site_transient_' : '_transient_';
		return array( $p . $key, $p . 'timeout_' . $key );
	}

	// The rows are read and written DIRECTLY (skyphusion_transient_rows, _put, _delete), never through the options
	// object cache: on approach A that group persists under the options version, and the wp_options version triggers
	// skip transient rows on purpose (cache-versions.mjs), so a cached copy in another isolate could be stale. The rows
	// are written with autoload off, so they never enter alloptions. Core's rule: expired rows go on read.
	// #1199 cost (measured: 15 transient reads on a warm shop page, 14 on a product page, 36 on the dashboard, each a
	// Hyperdrive query of about 14 ms): this request's rows in its OWN memory only (never across requests, so a write
	// in another isolate is seen by the next request), the site's learned names read in ONE query at the first
	// transient read, and the names this request read, learned at shutdown into one autoloaded option.
	const HOT_TRANSIENTS_MAX = 300;
	private $tmemo   = array(); // row name => array( found, value ), this request only
	private $tprimed = false;
	private $tread   = array(); // value-row names this request read
	// #1210: row names deleted in this request and not yet deleted in the database. A delete is cache invalidation,
	// so it is never skipped on a belief that the row is absent (another request may have set it since this one
	// read it). It is coalesced instead: the request's own reads see the delete at once (tmemo holds a tombstone),
	// a later set in this request removes its rows from the list, and the list is deleted in ONE statement when the
	// request ends (transient_flush). A strummer qtrace of one guest order on cf759hl: 404 delete statements, one
	// round trip each, 4,845 of 9,321 ms of database time. A set in ANOTHER request between this delete and the flush
	// is deleted by the flush; that only removes a cached value, which its owner rebuilds.
	private $tdelete = array();
	// #1210 lever 2: WooCommerce's order-item data store drops an item's meta cache on EVERY item save (clear_cache(),
	// abstract-wc-order-item-type-data-store.php:222), changed or not, so core reloaded the item's meta from the database:
	// a local guest order 25 loads for 9 writes, the last 16 with no write between; live (cf759hl) 44 loads, 605 ms. The
	// request keeps the last value it set in these groups as a SHADOW and serves it on a later miss while no write
	// statement has touched the group's table since. Any statement naming the table (any prefix) that is not plainly a
	// read clears every shadow of the group: INSERT, UPDATE, DELETE, REPLACE, a multi-table DELETE, or one that cannot
	// be parsed. WooCommerce writes woocommerce_order_itemmeta directly with $wpdb on item and order deletes, so the
	// guard is on statements, not on meta actions. Request-local only: a new request has no shadow.
	const SHADOW_TABLES = array( 'order_item_meta' => 'order_itemmeta' );
	private $shadow = array(); // group => key => the last value this request set
	const TRANSIENT_DELETE_CHUNK = 400;
	// #1210 follow-up (the lead's ruling): WooCommerce's cache-version counters, written ONCE per request. They are
	// WC_Cache_Helper::get_transient_version( $group, true ): "{group}-transient-version", set with no expiry, a new value
	// on each bump. A traced guest order on cf759hl bumped orders-transient-version 31 times (31 REPLACEs, 674 ms).
	// woo-edge.php measured and ruled this before #1206 (it defers the option write); durable transients bypass
	// update_option, so that deferral no longer ran. A set of one of these names updates the request memo at once (this
	// request reads the newest) and the newest value is written once, on transient_flush (the same guaranteed flush as the
	// deletes). Other requests see the previous version until this one ends, as before #1206. These are the exact names
	// WooCommerce 11.2.1 builds (the groups passed to get_transient_version, and Reports\Cache::VERSION_OPTION and
	// ProductFilters\CacheController::CACHE_GROUP); every other set, doing_cron included, is written at once.
	const VERSION_COUNTERS = array( 'orders-transient-version', 'product-transient-version', 'product_query-transient-version', 'shipping-transient-version', 'woocommerce_reports-transient-version', 'filter_data-transient-version' );
	private $tdefer = array(); // value-row name => the newest value, written at the end of the request

	private static function hot_get() {
		if ( defined( 'SKYPHUSION_TRANSIENT_HOT_GET' ) ) {
			return call_user_func( SKYPHUSION_TRANSIENT_HOT_GET );
		}
		return get_option( 'skyphusion_hot_transients' );
	}

	private static function hot_set( $names ) {
		if ( defined( 'SKYPHUSION_TRANSIENT_HOT_SET' ) ) {
			return call_user_func( SKYPHUSION_TRANSIENT_HOT_SET, $names );
		}
		return update_option( 'skyphusion_hot_transients', $names, true );
	}

	private static function timeout_of( $o ) {
		return 0 === strpos( $o, '_site_transient_' ) ? '_site_transient_timeout_' . substr( $o, 16 ) : '_transient_timeout_' . substr( $o, 11 );
	}

	/** Load the rows not in this request's memory, in one query. */
	private function tload( array $names ) {
		$need = array();
		foreach ( $names as $n ) {
			if ( ! isset( $this->tmemo[ $n ] ) ) {
				$need[] = $n;
			}
		}
		if ( ! $need ) {
			return;
		}
		$rows = skyphusion_transient_rows( $need );
		foreach ( $need as $n ) {
			$this->tmemo[ $n ] = array_key_exists( $n, $rows ) ? array( true, $rows[ $n ] ) : array( false, null );
		}
	}

	private function tprime() {
		if ( $this->tprimed ) {
			return;
		}
		$this->tprimed = true;
		$hot           = self::hot_get();
		if ( ! is_array( $hot ) || ! $hot ) {
			return;
		}
		$names = array();
		foreach ( $hot as $o ) {
			if ( is_string( $o ) && '' !== $o ) {
				$names[] = $o;
				$names[] = self::timeout_of( $o );
			}
		}
		$this->tload( $names );
	}

	/** At shutdown: add the names this request read to the learned list (only when it grows; capped). */
	public function transient_learn() {
		if ( ! $this->tread ) {
			return;
		}
		$hot = self::hot_get();
		$hot = is_array( $hot ) ? array_values( array_filter( $hot, 'is_string' ) ) : array();
		$new = array_values( array_diff( array_keys( $this->tread ), $hot ) );
		if ( ! $new || count( $hot ) >= self::HOT_TRANSIENTS_MAX ) {
			return;
		}
		self::hot_set( array_slice( array_merge( $hot, $new ), 0, self::HOT_TRANSIENTS_MAX ) );
	}

	private function durable_get( $key, $group, &$found ) {
		list( $o, $t ) = self::durable_names( $key, $group );
		$this->tprime();
		$this->tload( array( $o, $t ) );
		$this->tread[ $o ] = true;
		if ( $this->tmemo[ $t ][0] && (int) $this->tmemo[ $t ][1] < self::now() ) {
			$this->tdelete[ $o ] = true;
			$this->tdelete[ $t ] = true;
			$this->tmemo[ $o ] = array( false, null );
			$this->tmemo[ $t ] = array( false, null );
			$found             = false;
			++$this->cache_misses;
			return false;
		}
		$found = $this->tmemo[ $o ][0];
		if ( $found ) {
			++$this->cache_hits;
			return $this->tmemo[ $o ][1];
		}
		++$this->cache_misses;
		return false;
	}

	private function durable_set( $key, $data, $group, $expire ) {
		list( $o, $t ) = self::durable_names( $key, $group );
		$expire        = (int) $expire;
		if ( 'transient' === $group && $expire <= 0 && in_array( (string) $key, self::VERSION_COUNTERS, true ) ) {
			// A version counter: the newest value now in this request, one write at its end. No expiry: an existing
			// timeout row is left as it is, as core does.
			unset( $this->tdelete[ $o ] );
			$this->tdefer[ $o ] = $data;
			$this->tmemo[ $o ]  = array( true, $data );
			return true;
		}
		unset( $this->tdefer[ $o ] );
		// As core: an expiry writes the timeout row; no expiry leaves an existing timeout row as it is.
		if ( $expire > 0 ) {
			skyphusion_transient_put( $t, self::now() + $expire );
			$this->tmemo[ $t ] = array( true, self::now() + $expire );
			unset( $this->tdelete[ $t ] );
		}
		unset( $this->tdelete[ $o ] );
		$ok                = skyphusion_transient_put( $o, $data );
		$this->tmemo[ $o ] = array( true, $data );
		return $ok;
	}

	private function durable_delete( $key, $group ) {
		list( $o, $t ) = self::durable_names( $key, $group );
		// Core's answer is whether the value existed, and on true delete_transient() fires deleted_transient, which
		// WooCommerce listens to (ProductFilterAttribute cascades wc_attribute_taxonomies to its default-attribute
		// transient). This request knows the answer when it has read the row (the prime of the learned names covers
		// most). A row it never read answers TRUE, without a query: a delete of a missing row then fires one extra
		// hook, which only deletes more cache; false would skip a cascade for a row that did exist.
		$had                 = isset( $this->tmemo[ $o ] ) ? $this->tmemo[ $o ][0] : true;
		unset( $this->tdefer[ $o ] ); // a deferred version set, then a delete: the delete wins
		$this->tmemo[ $o ]   = array( false, null );
		$this->tmemo[ $t ]   = array( false, null );
		$this->tdelete[ $o ] = true;
		$this->tdelete[ $t ] = true;
		return $had;
	}

	/**
	 * #1210 lever 2: the query filter. A statement that names a shadowed group's table and is not plainly a read clears
	 * that group's shadows. Plainly a read: after leading space, comments and parentheses, it starts with SELECT, SHOW,
	 * DESCRIBE, DESC or EXPLAIN. Anything else, or anything this cannot parse, clears (the next read reloads). The
	 * statement is returned untouched.
	 */
	public function shadow_guard( $query ) {
		if ( ! $this->shadow || ! is_string( $query ) ) {
			return $query;
		}
		foreach ( self::SHADOW_TABLES as $group => $table ) {
			if ( empty( $this->shadow[ $group ] ) || false === stripos( $query, $table ) ) {
				continue;
			}
			$head = preg_replace( '#^(?:\s+|\(|/\*.*?\*/|--[^\n]*(?:\n|$)|\#[^\n]*(?:\n|$))+#s', '', $query );
			if ( ! is_string( $head ) || ! preg_match( '/^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i', $head ) ) {
				unset( $this->shadow[ $group ] );
			}
		}
		return $query;
	}

	/** #1210: delete this request's pending transient rows, in one statement per chunk. Idempotent. */
	public function transient_flush() {
		// #1210 follow-up: the deferred version counters first, each once, the newest value.
		$defer        = $this->tdefer;
		$this->tdefer = array();
		foreach ( $defer as $name => $value ) {
			skyphusion_transient_put( $name, $value );
		}
		if ( ! $this->tdelete ) {
			return 0;
		}
		$names         = array_keys( $this->tdelete );
		$this->tdelete = array();
		$n             = 0;
		foreach ( array_chunk( $names, self::TRANSIENT_DELETE_CHUNK ) as $chunk ) {
			$n += (int) skyphusion_transient_delete( $chunk );
		}
		return $n;
	}

	private function persistent( $group ) {
		if ( $this->force_off ) {
			return false;
		}
		// #1199: transients never go to the cross-request cache: the database holds them (durable(); per request while
		// WordPress installs).
		if ( 'transient' === $group || 'site-transient' === $group ) {
			return false;
		}
		// #491: on approach A, options stay per request whatever else says, UNLESS this request read
		// an exact options version (#296 (2)): then a write anywhere moves every options key at once.
		if ( null !== $this->persist_allow && 'options' === $group ) {
			return isset( $this->versions['options'] );
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
		if ( self::durable( $group ) ) {
			return $this->durable_get( $key, $group, $found );
		}
		$this->version_gate( $group );
		if ( $this->has_local( $key, $group ) && ! $force ) {
			$found = true;
			++$this->cache_hits;
			return self::copy( $this->cache[ $group ][ $key ] );
		}
		if ( ! $force && isset( $this->shadow[ $group ] ) && array_key_exists( $key, $this->shadow[ $group ] ) ) {
			// #1210 lever 2: no write to the table since this request set it.
			$this->cache[ $group ][ $key ] = self::copy( $this->shadow[ $group ][ $key ] );
			unset( $this->missing[ $group ][ $key ] );
			$found = true;
			++$this->cache_hits;
			return self::copy( $this->shadow[ $group ][ $key ] );
		}
		if ( $this->persistent( $group ) && empty( $this->missing[ $group ][ $key ] ) && ! $this->options_known_miss( $key, $group ) ) {
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
		if ( self::durable( $group ) ) {
			$out = array();
			foreach ( $keys as $key ) {
				$out[ $key ] = $this->get( $key, $group, $force );
			}
			return $out;
		}
		$this->version_gate( $group );
		$out  = array();
		$need = array();
		foreach ( $keys as $key ) {
			if ( $this->has_local( $key, $group ) && ! $force ) {
				$out[ $key ] = self::copy( $this->cache[ $group ][ $key ] );
				++$this->cache_hits;
			} elseif ( ! $force && isset( $this->shadow[ $group ] ) && array_key_exists( $key, $this->shadow[ $group ] ) ) {
				$this->cache[ $group ][ $key ] = self::copy( $this->shadow[ $group ][ $key ] );
				unset( $this->missing[ $group ][ $key ] );
				$out[ $key ] = self::copy( $this->shadow[ $group ][ $key ] );
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
		if ( self::durable( $group ) ) {
			return $this->durable_set( $key, $data, $group, $expire );
		}
		$this->version_gate( $group );
		$this->cache[ $group ][ $key ] = self::copy( $data );
		unset( $this->missing[ $group ][ $key ] );
		if ( isset( self::SHADOW_TABLES[ $group ] ) ) {
			$this->shadow[ $group ][ $key ] = self::copy( $data );
		}
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
		if ( self::durable( $group ) ) {
			return $this->durable_delete( $key, $group );
		}
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

	/**
	 * Drop THIS request's copy of a value, nothing else (#728): no bridge call, so the Map (and the KV tier) keep it,
	 * and no known-missing mark, so a later get in this request reads it back from the Map. Only memory is freed: get()
	 * hands out copies, so no caller holds the instance dropped here.
	 */
	public function forget_local( $key, $group = 'default' ) {
		unset( $this->cache[ $group ][ $key ] );
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
		$this->shadow  = array();
		$this->call( array( 'op' => 'flush' ) );
		return true;
	}

	public function flush_runtime() {
		$this->cache   = array();
		$this->missing = array();
		$this->shadow  = array();
		return true;
	}

	public function flush_group( $group ) {
		unset( $this->cache[ $group ], $this->missing[ $group ], $this->shadow[ $group ] );
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

/**
 * #1199: the transient rows, read and written directly in wp_options (JS_Object_Cache::durable()): never through the
 * options object cache, autoload off. A test may define its own before this file loads.
 */
if ( ! function_exists( 'skyphusion_transient_rows' ) ) {
	/** @return array<string, mixed> name => unserialized value, for the names that exist. */
	function skyphusion_transient_rows( array $names ) {
		global $wpdb;
		if ( ! $names || ! isset( $wpdb ) ) {
			return array();
		}
		$in   = implode( ',', array_fill( 0, count( $names ), '%s' ) );
		$rows = $wpdb->get_results( $wpdb->prepare( "SELECT option_name, option_value FROM {$wpdb->options} WHERE option_name IN ($in)", $names ) );
		$out  = array();
		foreach ( (array) $rows as $r ) {
			$out[ $r->option_name ] = maybe_unserialize( $r->option_value );
		}
		return $out;
	}
	function skyphusion_transient_put( $name, $value ) {
		global $wpdb;
		return false !== $wpdb->replace( $wpdb->options, array( 'option_name' => $name, 'option_value' => maybe_serialize( $value ), 'autoload' => 'off' ), array( '%s', '%s', '%s' ) );
	}
	function skyphusion_transient_delete( array $names ) {
		global $wpdb;
		if ( ! $names ) {
			return 0;
		}
		$in = implode( ',', array_fill( 0, count( $names ), '%s' ) );
		return (int) $wpdb->query( $wpdb->prepare( "DELETE FROM {$wpdb->options} WHERE option_name IN ($in)", $names ) );
	}
}

/**
 * #1199: transients live in wp_options (JS_Object_Cache::durable()). Core's daily delete_expired_transients cron
 * returns early while an external cache is in use (delete_expired_transients( $force_db = false )), so the drop-in
 * runs core's own cleanup on the database instead, after core's no-op.
 */
function skyphusion_delete_expired_transients_db() {
	delete_expired_transients( true );
}
if ( function_exists( 'add_action' ) ) {
	add_action( 'delete_expired_transients', 'skyphusion_delete_expired_transients_db', 11 );
}
