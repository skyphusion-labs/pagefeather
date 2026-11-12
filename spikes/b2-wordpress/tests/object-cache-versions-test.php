<?php
// php spikes/b2-wordpress/tests/object-cache-versions-test.php
//
// Exact invalidation for the approach-A object cache (#296 slice 1). The versioned groups
// (JS_OBJECT_CACHE_VERSIONED) persist under their version from <prefix>skyph_cache_versions,
// read ONCE per request, as the group salt. Here a real shared store stands in for the isolate
// Map / L2 (each "request" is a new JS_Object_Cache), a fake $wpdb serves the versions table, and
// a write is a version bump, as the AFTER triggers make one. THE POSITIVE CONTROL: a value cached
// before a write is a hit, and the request after the write misses it, for every versioned group.

$GLOBALS['store'] = array();      // the persistent store across requests (isolate Map / L2)
$GLOBALS['oc_ops'] = array();
function post_message_to_js( $json ) {
	$m  = json_decode( $json, true );
	$op = isset( $m['oc'] ) ? $m['oc'] : array();
	$GLOBALS['oc_ops'][] = $op;
	switch ( isset( $op['op'] ) ? $op['op'] : '' ) {
		case 'get':
			return json_encode( array( 'v' => array_map( function ( $k ) { return isset( $GLOBALS['store'][ $k ] ) ? $GLOBALS['store'][ $k ] : null; }, $op['k'] ) ) );
		case 'set':
			$GLOBALS['store'][ $op['k'] ] = $op['v'];
			return json_encode( array( 'ok' => true ) );
		case 'del':
			$n = 0; foreach ( $op['k'] as $k ) { if ( isset( $GLOBALS['store'][ $k ] ) ) { unset( $GLOBALS['store'][ $k ] ); $n++; } }
			return json_encode( array( 'ok' => true, 'n' => $n ) );
	}
	return json_encode( array( 'ok' => true, 'n' => 0 ) );
}
function is_multisite() { return false; }
function get_current_blog_id() { return 1; }
function wp_suspend_cache_addition() { return false; }
define( 'ARRAY_N', 'ARRAY_N' );

class Fake_WPDB {
	public $prefix = 'wp_';
	public $versions = array( 'posts' => 0, 'post_meta' => 0, 'options' => 0 );
	public $table = true;
	public $reads = 0;
	public $last_sql = '';
	public function suppress_errors( $on = true ) { return false; }
	public function get_results( $sql, $mode ) {
		$this->reads++; $this->last_sql = $sql;
		if ( ! $this->table ) { return null; }
		$out = array(); foreach ( $this->versions as $g => $v ) { $out[] = array( $g, (string) $v ); }
		return $out;
	}
	// A write to a versioned table: the trigger bumps its group in the same statement.
	public function write( $grp ) { $this->versions[ $grp ]++; }
}
$GLOBALS['wpdb'] = new Fake_WPDB();

define( 'JS_OBJECT_CACHE_PERSIST_GROUPS', 'options,terms' );
define( 'JS_OBJECT_CACHE_TTL', 10 );
define( 'JS_OBJECT_CACHE_VERSIONED', 'posts,post_meta,options' );
require __DIR__ . '/../php/object-cache-js.php';

$fail = 0;
function check( $label, $cond ) { global $fail; if ( $cond ) { echo "ok   $label\n"; return; } $fail++; echo "FAIL $label\n"; }
function request() { return new JS_Object_Cache(); }
function sets_of( $group ) { return array_values( array_filter( $GLOBALS['oc_ops'], function ( $o ) use ( $group ) { return isset( $o['op'] ) && 'set' === $o['op'] && 0 === strpos( $o['k'], $group . "\0" ); } ) ); }
$db = $GLOBALS['wpdb'];

// 1. THE POSITIVE CONTROL, for each versioned group: hit before the write, MISS after it.
foreach ( array( 'posts', 'post_meta', 'options' ) as $g ) {
	$r1 = request(); $r1->set( 'k1', "old-$g", $g );
	$found = null; $v = request()->get( 'k1', $g, false, $found );
	check( "$g: the next request reads the cached value (a hit, the store is used)", true === $found && "old-$g" === $v );
	$db->write( $g );
	$found = null; $v = request()->get( 'k1', $g, false, $found );
	check( "$g: after a write (its version bumped), the next request MISSES the old key", false === $found && false === $v );
	$r4 = request(); $r4->set( 'k1', "new-$g", $g );
	$found = null; $v = request()->get( 'k1', $g, false, $found );
	check( "$g: the value cached after the write is read by the next request", true === $found && "new-$g" === $v );
}

// 2. The persistent key carries the version as the salt.
$GLOBALS['oc_ops'] = array();
request()->set( 'k2', 'x', 'posts' );
$s = sets_of( 'posts' );
check( 'a versioned set goes to the store under its version salt (posts\0v1\0...)', 1 === count( $s ) && 0 === strpos( $s[0]['k'], "posts\0v" . $db->versions['posts'] . "\0" ) );

// 3. ONE version read per request, however many versioned operations it makes.
$db->reads = 0;
$r = request();
for ( $i = 0; $i < 20; $i++ ) { $r->get( "a$i", 'posts' ); $r->set( "b$i", $i, 'post_meta' ); $r->get( "c$i", 'options' ); }
check( 'one request with 60 versioned operations reads the versions ONCE', 1 === $db->reads && 1 === $r->version_reads );
check( 'the read is the standalone versions query on the prefixed table', 'SELECT grp, v FROM wp_skyph_cache_versions' === $db->last_sql );
$db->reads = 0;
$r = request(); $r->get( 'x', 'terms' ); $r->set( 'y', 1, 'woocommerce_sessions' );
check( 'a request that touches no versioned group reads no versions', 0 === $db->reads );

// 4. A bump invalidates ONLY its own group.
$a = request(); $a->set( 'only', 'p', 'posts' ); $a->set( 'only', 'o', 'options' ); $a->set( 'only', 't', 'terms' );
$db->write( 'posts' );
$b = request();
$fp = null; $b->get( 'only', 'posts', false, $fp );
$fo = null; $vo = $b->get( 'only', 'options', false, $fo );
$ft = null; $vt = $b->get( 'only', 'terms', false, $ft );
check( 'a posts write: posts misses, options and terms (other groups) still hit', false === $fp && true === $fo && 'o' === $vo && true === $ft && 't' === $vt );

// 5. A request-start snapshot: a write DURING a request is seen from the next request on.
$c = request(); $c->get( 'snap', 'posts' );           // this request read version n
$c->set( 'snap', 'during', 'posts' );                  // a value under version n
$db->write( 'posts' );                                 // another request writes: n+1
$found = null; $c->get( 'snap', 'posts', false, $found );
check( 'the same request keeps its snapshot (its own value, version n)', true === $found );
$found = null; request()->get( 'snap', 'posts', false, $found );
check( 'the next request is on version n+1 and misses that value', false === $found );

// 6. No versions table (not installed, or a provider with no triggers): no salt, old posture.
$db->table = false; $GLOBALS['oc_ops'] = array();
$d = request(); $d->set( 'nt', 'v', 'posts' ); $d->set( 'nt', 'v', 'options' );
check( 'no table: posts stays per request (never reaches the store)', 0 === count( sets_of( 'posts' ) ) );
$o = sets_of( 'options' );
check( 'no table: options keeps the allowlisted, TTL-bounded posture (ttl 10, no salt)', 1 === count( $o ) && 10 === $o[0]['ttl'] && 0 === strpos( $o[0]['k'], "options\0nt" ) );
$db->table = true;

// 7. The spike-gated force-off reads no versions.
$_SERVER['HTTP_X_OC_OFF'] = '1'; $db->reads = 0;
request()->get( 'z', 'posts' );
check( 'x-oc-off: no version read, nothing persistent', 0 === $db->reads );
unset( $_SERVER['HTTP_X_OC_OFF'] );

echo $fail ? "$fail failing check(s)\n" : "all passed\n";
exit( $fail ? 1 : 0 );
