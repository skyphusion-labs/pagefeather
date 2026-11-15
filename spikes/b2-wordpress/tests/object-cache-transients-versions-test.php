<?php
// php spikes/b2-wordpress/tests/object-cache-transients-versions-test.php   (#296 (2), the transient half)
//
// With an external object cache, WordPress keeps transients ONLY in it (wp-includes/option.php), and on
// approach A only theme_json persisted across requests, so every WooCommerce transient was rebuilt on
// every request (the 11-15 off/on split). Here transients persist across isolates, EXACT: each name hashes
// into one of 64 version buckets (rows tb0..tb63 of <prefix>skyph_cache_versions, read once per request
// with the options version). A set or delete bumps its bucket in the database BEFORE the value is written,
// and the value is written under the new version. Measured first (#296, 11-15 tlog): 0 transient writes
// per page view; every write comes from an order or a product change. The shared store LAGS, as #491
// measured. Each "request" is a new JS_Object_Cache.
//   php object-cache-transients-versions-test.php [path/to/object-cache-js.php]

$GLOBALS['store'] = array();
$GLOBALS['ops']   = array();
$GLOBALS['lag']   = false;
function post_message_to_js( $json ) {
	$m  = json_decode( $json, true );
	$op = isset( $m['oc'] ) ? $m['oc'] : array();
	$GLOBALS['ops'][] = $op;
	if ( 'get' === $op['op'] ) {
		$out = array();
		foreach ( $op['k'] as $k ) {
			$out[] = array_key_exists( $k, $GLOBALS['store'] ) ? $GLOBALS['store'][ $k ] : null;
		}
		return json_encode( array( 'v' => $out ) );
	}
	if ( 'set' === $op['op'] && ! $GLOBALS['lag'] ) {
		$GLOBALS['store'][ $op['k'] ] = $op['v'];
	}
	return json_encode( array( 'ok' => true, 'n' => 0 ) );
}
function is_multisite() { return false; }
function get_current_blog_id() { return 1; }
function wp_suspend_cache_addition() { return false; }
if ( ! defined( 'ARRAY_N' ) ) {
	define( 'ARRAY_N', 'ARRAY_N' );
}
class Fake_WPDB {
	public $prefix = 'wp_';
	public $rows = array();   // grp => v
	public $table = true;
	public $reads = 0;        // versions-table reads (the once-per-request read)
	public $writes = 0;       // bumps
	public $sql = array();
	public $fail_bump = false;
	public function __construct() {
		$this->rows['options'] = 0;
		for ( $i = 0; $i < 64; $i++ ) {
			$this->rows[ 'tb' . $i ] = 0;
		}
	}
	public function suppress_errors( $on = true ) { return false; }
	public function get_results( $sql, $mode = null ) {
		$this->sql[] = $sql;
		if ( false !== strpos( $sql, 'skyph_cache_versions' ) ) {
			++$this->reads;
			if ( ! $this->table ) {
				return null;
			}
			$out = array();
			foreach ( $this->rows as $g => $v ) {
				$out[] = array( $g, (string) $v );
			}
			return $out;
		}
		return array();
	}
	public function query( $sql ) {
		$this->sql[] = $sql;
		if ( preg_match( "/^UPDATE wp_skyph_cache_versions SET v = v \\+ 1 WHERE grp = '(tb[0-9]+)'$/", $sql, $m ) ) {
			if ( $this->fail_bump || ! $this->table ) {
				return false;
			}
			++$this->writes;
			++$this->rows[ $m[1] ];
			return 1;
		}
		return false;
	}
	public function get_var( $sql ) {
		$this->sql[] = $sql;
		if ( preg_match( "/^SELECT v FROM wp_skyph_cache_versions WHERE grp = '(tb[0-9]+)'$/", $sql, $m ) ) {
			return $this->table && isset( $this->rows[ $m[1] ] ) ? (string) $this->rows[ $m[1] ] : null;
		}
		return null;
	}
}
$GLOBALS['wpdb'] = new Fake_WPDB();
define( 'JS_OBJECT_CACHE_PERSIST_GROUPS', 'theme_json' );
define( 'JS_OBJECT_CACHE_TTL', 10 );
define( 'JS_OBJECT_CACHE_VERSIONED', 'options,transient,site-transient' );
require isset( $argv[1] ) ? $argv[1] : __DIR__ . '/../php/object-cache-js.php';

$fail = 0;
function check( $label, $cond ) {
	global $fail;
	echo ( $cond ? 'ok   ' : 'FAIL ' ) . $label . "\n";
	$fail += $cond ? 0 : 1;
}
function bucket_of( $key ) {
	return 'tb' . ( abs( crc32( (string) $key ) ) % 64 );
}
function shared_ops( $group ) {
	return count( array_filter( $GLOBALS['ops'], function ( $op ) use ( $group ) {
		foreach ( (array) ( isset( $op['k'] ) ? $op['k'] : array() ) as $k ) {
			if ( 0 === strpos( (string) $k, $group . "\0" ) ) {
				return true;
			}
		}
		return false;
	} ) );
}
$wpdb = $GLOBALS['wpdb'];
// Two keys in DIFFERENT buckets (so a bump of one never touches the other).
$k1 = 'wc_related_2710';
$k2 = null;
foreach ( array( 'product-transient-version', 'orders-transient-version', 'wc_related_2705', 'wc_related_2708', 'x1', 'x2', 'x3' ) as $c ) {
	if ( bucket_of( $c ) !== bucket_of( $k1 ) ) {
		$k2 = $c;
		break;
	}
}
check( 'the two probe keys fall in different buckets', null !== $k2 );

// Request 1, isolate X: a miss, then WooCommerce rebuilds and sets both transients.
$x = new JS_Object_Cache();
$found = null;
$x->get( $k1, 'transient', false, $found );
$q0 = count( $wpdb->sql );
$x->set( $k1, array( 'A' ), 'transient', 86400 );
check( 'request 1: one versions read', 1 === $wpdb->reads );
// Request 1 SET k1 after a MISS: a regeneration (#643 probe (b) cascade fix). No bump; one safe re-check read of the
// shared store (a bridge get, not SQL); the value is written. The bump cases are checked below (overwrite, explicit write).
check( 'request 1: a regeneration set after a miss does not bump (no SQL, version unchanged)', 0 === count( $wpdb->sql ) - $q0 && 0 === $wpdb->writes && 0 === $wpdb->rows[ bucket_of( $k1 ) ] );
check( 'request 1: the value is written to the shared store', shared_ops( 'transient' ) >= 1 );
$x->set( $k2, array( 'K2' ), 'transient', 86400 );

// Request 2, isolate Y: hits across isolates, for both keys. Today every transient misses here.
$GLOBALS['ops'] = array();
$y = new JS_Object_Cache();
$h1 = $y->get( $k1, 'transient', false, $found );
check( 'request 2: k1 is a hit from the shared store', array( 'A' ) === $h1 && true === $found );
$h2 = $y->get( $k2, 'transient', false, $found );
check( 'request 2: k2 is a hit too', array( 'K2' ) === $h2 );
check( 'request 2: still one versions read for the request (2 in all)', 2 === $wpdb->reads );

// Isolate X sets k1 again (an order changed the product); the new value is IN FLIGHT: the store lags.
$GLOBALS['lag'] = true;
$x->set( $k1, array( 'B' ), 'transient', 86400 );

// Request 3, isolate Y: k1's bucket moved. Never the stale A; k2's bucket did not move: still a hit.
$y3 = new JS_Object_Cache();
$g1 = $y3->get( $k1, 'transient', false, $found );
check( 'request 3: after the set, k1 misses: never the stale A', false === $g1 && false === $found );
$g2 = $y3->get( $k2, 'transient', false, $found );
check( 'request 3: k2, in another bucket, is still a hit', array( 'K2' ) === $g2 );

// The value lands; request 4 hits the new value.
$GLOBALS['lag'] = false;
$x->set( $k1, array( 'C' ), 'transient', 86400 );
$y4 = new JS_Object_Cache();
check( 'request 4: a hit on the newest value', array( 'C' ) === $y4->get( $k1, 'transient', false, $found ) );

// A delete (delete_transient) bumps too: the next request in any isolate misses.
$x5 = new JS_Object_Cache();
$x5->delete( $k1, 'transient' );
$y5 = new JS_Object_Cache();
check( 'a delete bumps: the next request misses', false === $y5->get( $k1, 'transient', false, $found ) );

// A failed bump never writes under the old version (the stale-read case): the set stays local.
$wpdb->fail_bump = true;
$GLOBALS['ops'] = array();
$z = new JS_Object_Cache();
$z->set( $k2, array( 'NEW' ), 'transient', 86400 );
check( 'a failed bump: nothing is written to the shared store', 0 === count( array_filter( $GLOBALS['ops'], function ( $op ) { return 'set' === $op['op']; } ) ) );
check( 'a failed bump: the request still sees its own value', array( 'NEW' ) === $z->get( $k2, 'transient', false, $found ) );
// The version did not move, so every isolate still asks for the OLD key: its old value must go, or it
// would be served stale until it expires.
$dels = array_filter( $GLOBALS['ops'], function ( $op ) { return 'del' === $op['op']; } );
check( 'a failed bump on a set: the old entry is deleted from the shared store', 1 === count( $dels ) );
$GLOBALS['ops'] = array();
$z2 = new JS_Object_Cache();
$z2->delete( $k2, 'transient' );
$dels = array_filter( $GLOBALS['ops'], function ( $op ) { return 'del' === $op['op']; } );
check( 'a failed bump on a delete: the old entry is deleted from the shared store too', 1 === count( $dels ) );
$wpdb->fail_bump = false;

// No versions table: transients stay per request on A, as before.
$wpdb->table    = false;
$GLOBALS['ops'] = array();
$n = new JS_Object_Cache();
$n->get( $k1, 'transient', false, $found );
$n->set( $k1, array( 'D' ), 'transient', 86400 );
check( 'no table: transients send nothing to the shared store', 0 === shared_ops( 'transient' ) );

// The lead's check (2026-11-15): a set in bucket k leaves every OTHER bucket's cached values in place.
// Keys spread over at least 8 distinct buckets are cached; then one key is set again; a new request in
// another isolate must still hit every key outside that key's bucket.
$wpdb->table = true;
$GLOBALS['lag'] = false;
$GLOBALS['store'] = array();
$keys = array();
$seen = array();
for ( $i = 0; count( $seen ) < 12 && $i < 500; $i++ ) {
	$c = 'spread_' . $i;
	$b = bucket_of( $c );
	if ( ! isset( $seen[ $b ] ) ) {
		$seen[ $b ] = true;
		$keys[]     = $c;
	}
}
check( 'spread: 12 keys in 12 distinct buckets', 12 === count( $keys ) );
$w = new JS_Object_Cache();
foreach ( $keys as $c ) {
	$w->set( $c, array( 'v' => $c ), 'transient', 86400 );
}
$hot = $keys[0];
$w2  = new JS_Object_Cache();
$w2->set( $hot, array( 'v' => 'changed' ), 'transient', 86400 );
$r   = new JS_Object_Cache();
$hits = 0;
foreach ( array_slice( $keys, 1 ) as $c ) {
	$hits += ( array( 'v' => $c ) === $r->get( $c, 'transient', false, $found ) ) ? 1 : 0;
}
check( 'a set in one bucket leaves all 11 other buckets cached (11 of 11 hits)', 11 === $hits );
check( 'and the changed key reads its new value', array( 'v' => 'changed' ) === $r->get( $hot, 'transient', false, $found ) );

// ---- The bump cascade (#643 probe (b), 2026-11-15): 1,295 bucket bumps in 22 quiet requests. A regeneration set
// after a miss bumped its bucket, every co-bucketed transient then missed, was regenerated, set, and bumped again.
// Ruled: a set bumps only when it may OVERWRITE a cached value (the safe variant re-checks the shared store).
$GLOBALS['store'] = array();
$GLOBALS['lag']   = false;
$wpdb->table = true; $wpdb->fail_bump = false;
$same = array();
for ( $i = 0; count( $same ) < 2 && $i < 5000; $i++ ) {
	$c = 'cascade_' . $i;
	if ( 'tb7' === bucket_of( $c ) ) {
		$same[] = $c;
	}
}
check( 'cascade: two keys in one bucket', 2 === count( $same ) );
list( $ka, $kb ) = $same;
$seed = new JS_Object_Cache();
$seed->set( $kb, array( 'B' ), 'transient', 86400 ); // kb cached (an explicit write, never read: it bumps)
$w0 = $wpdb->writes;
// A request regenerates ka after a miss: it must NOT bump, so kb stays cached for everyone.
$r1 = new JS_Object_Cache();
$r1->get( $ka, 'transient', false, $found );
$r1->set( $ka, array( 'A' ), 'transient', 86400 );
check( 'a regeneration set after a miss does NOT bump its bucket', $w0 === $wpdb->writes );
$r2 = new JS_Object_Cache();
check( 'so the co-bucketed kb is still a hit in the next request', array( 'B' ) === $r2->get( $kb, 'transient', false, $found ) );
check( 'and ka reads its regenerated value', array( 'A' ) === $r2->get( $ka, 'transient', false, $found ) );
// An overwrite after a hit bumps.
$w1 = $wpdb->writes;
$r3 = new JS_Object_Cache();
$r3->get( $ka, 'transient', false, $found );
$r3->set( $ka, array( 'A2' ), 'transient', 86400 );
check( 'an overwrite after a hit bumps', $w1 + 1 === $wpdb->writes );
// A write of a key not read in this request (an explicit write, e.g. a version refresh) bumps.
$w2 = $wpdb->writes;
$r4 = new JS_Object_Cache();
$r4->set( $ka, array( 'A3' ), 'transient', 86400 );
check( 'a write of a key not read in this request bumps', $w2 + 1 === $wpdb->writes );
// The race (the safe variant): X finds kc absent; Y regenerates kc = OLD (no bump); X then writes kc = NEW. X
// re-checks the shared store, sees Y's value, and bumps: the next request reads NEW, never Y's OLD.
$kc = 'race_key_1';
$x  = new JS_Object_Cache();
$x->get( $kc, 'transient', false, $found );
$y  = new JS_Object_Cache();
$y->get( $kc, 'transient', false, $found );
$y->set( $kc, array( 'OLD' ), 'transient', 86400 );
$w3 = $wpdb->writes;
$x->set( $kc, array( 'NEW' ), 'transient', 86400 );
check( 'the race: X re-checks, finds a value written meanwhile, and bumps', $w3 + 1 === $wpdb->writes );
$n = new JS_Object_Cache();
check( 'the race: the next request reads NEW, never the stale OLD', array( 'NEW' ) === $n->get( $kc, 'transient', false, $found ) );
// A delete of a key found absent (and still absent) does not bump; any other delete bumps.
$w4 = $wpdb->writes;
$d  = new JS_Object_Cache();
$d->get( 'never_set_key', 'transient', false, $found );
$d->delete( 'never_set_key', 'transient' );
check( 'a delete of a key found absent does not bump', $w4 === $wpdb->writes );
$w5 = $wpdb->writes;
$d2 = new JS_Object_Cache();
$d2->delete( $ka, 'transient' );
check( 'a delete of a key not read here bumps', $w5 + 1 === $wpdb->writes );

// #296 (b) probe v2, measure only: every bucketed set that BUMPS says whether the new value equals the copy this
// request already held, on the SERIALIZED value (two distinct objects with the same fields are equal), or that it had
// none (a blind set). A regeneration says so. Every bumping delete is counted too, so the counts cover every bump.
function last_op( $type ) {
	for ( $i = count( $GLOBALS['ops'] ) - 1; $i >= 0; $i-- ) {
		if ( $type === $GLOBALS['ops'][ $i ]['op'] ) {
			return $GLOBALS['ops'][ $i ];
		}
	}
	return null;
}
$ke = 'probe_eq_key';
$p  = new JS_Object_Cache();
$p->set( $ke, (object) array( 'x' => 1 ), 'transient', 86400 );
$s = last_op( 'set' );
check( 'probe v2: a blind set says nolocal', isset( $s['pc'] ) && 'nolocal' === $s['pc'] );
$we = $wpdb->writes;
$p->set( $ke, (object) array( 'x' => 1 ), 'transient', 86400 );
$s = last_op( 'set' );
check( 'probe v2: behavior unchanged, an equal set still bumps', $we + 1 === $wpdb->writes );
check( 'probe v2: a set of a distinct object with equal fields says eq', isset( $s['pc'] ) && 'eq' === $s['pc'] );
$p->set( $ke, (object) array( 'x' => 2 ), 'transient', 86400 );
$s = last_op( 'set' );
check( 'probe v2: a set of a different value says ne', isset( $s['pc'] ) && 'ne' === $s['pc'] );
$p2 = new JS_Object_Cache();
$p2->get( 'probe_regen_key', 'transient', false, $found );
$p2->set( 'probe_regen_key', array( 'R' ), 'transient', 86400 );
$s = last_op( 'set' );
check( 'probe v2: a regeneration set says regen', isset( $s['pc'] ) && 'regen' === $s['pc'] );
$p3 = new JS_Object_Cache();
$n0 = count( $GLOBALS['ops'] );
$w6 = $wpdb->writes;
$p3->delete( $ke, 'transient' );
$c = last_op( 'count' );
check( 'probe v2: a bumping delete is counted', $w6 + 1 === $wpdb->writes && null !== $c && 'del_bump' === $c['f'] && count( $GLOBALS['ops'] ) > $n0 );

echo $fail ? "$fail failing check(s)\n" : "all checks pass\n";
exit( $fail ? 1 : 0 );
