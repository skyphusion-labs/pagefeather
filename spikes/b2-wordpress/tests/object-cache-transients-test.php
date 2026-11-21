<?php
// php spikes/b2-wordpress/tests/object-cache-transients-test.php   (#1199)
//
// joan, #1199: a transient set in one request was gone on the next (a permalink save, its 302, then the GET found no
// settings_errors transient: 3 of 3 by hand). With our drop-in loaded, wp_using_ext_object_cache() is true, so core's
// set_transient() and get_transient() go ONLY to wp_cache_set/get( ..., 'transient' ). On approach A only the allowlist
// persists (JS_OBJECT_CACHE_PERSIST_GROUPS, default theme_json), so a transient lived in that request's PHP array and
// died with it; on b-dosql it lived in the object's Map and died with the object. Transients must be durable: the
// transient and site-transient groups are stored as core stores them without an external cache, option rows
// _transient_<name> and _transient_timeout_<name> (and _site_transient_*).
//
// The option API here is a stub over one shared array, the database. Each new JS_Object_Cache is a fresh runtime.

$GLOBALS['db']  = array();   // the wp_options table: name => value
$GLOBALS['now'] = 1000000;
$GLOBALS['ops'] = array();
function post_message_to_js( $json ) {
	$m = json_decode( $json, true );
	$GLOBALS['ops'][] = isset( $m['oc'] ) ? $m['oc'] : array();
	return json_encode( array( 'ok' => true, 'v' => array() ) );
}
function is_multisite() { return false; }
function get_current_blog_id() { return 1; }
function wp_suspend_cache_addition() { return false; }
function wp_installing() { return ! empty( $GLOBALS['installing'] ); }
function wp_prime_option_caches( $names ) {}
function get_option( $n, $d = false ) { return array_key_exists( $n, $GLOBALS['db'] ) ? $GLOBALS['db'][ $n ] : $d; }
function add_option( $n, $v = '', $dep = '', $autoload = null ) { if ( array_key_exists( $n, $GLOBALS['db'] ) ) { return false; } $GLOBALS['db'][ $n ] = $v; return true; }
function update_option( $n, $v, $autoload = null ) { $GLOBALS['db'][ $n ] = $v; return true; }
function delete_option( $n ) { $had = array_key_exists( $n, $GLOBALS['db'] ); unset( $GLOBALS['db'][ $n ] ); return $had; }
function get_site_option( $n, $d = false ) { return get_option( $n, $d ); }
function add_site_option( $n, $v ) { return add_option( $n, $v ); }
function update_site_option( $n, $v ) { return update_option( $n, $v ); }
function delete_site_option( $n ) { return delete_option( $n ); }
// The row functions the drop-in uses (its own read wp_options with $wpdb, never the options cache), over the same table.
$GLOBALS['autoload'] = array();
$GLOBALS['row_queries'] = 0;
function skyphusion_transient_rows( array $names ) { ++$GLOBALS['row_queries']; $o = array(); foreach ( $names as $n ) { if ( array_key_exists( $n, $GLOBALS['db'] ) ) { $o[ $n ] = $GLOBALS['db'][ $n ]; } } return $o; }
function skyphusion_transient_put( $n, $v ) { $GLOBALS['db'][ $n ] = $v; $GLOBALS['autoload'][ $n ] = 'off'; return true; }
$GLOBALS['delete_stmts'] = 0;
function skyphusion_transient_delete( array $names ) { ++$GLOBALS['delete_stmts']; $k = 0; foreach ( $names as $n ) { if ( array_key_exists( $n, $GLOBALS['db'] ) ) { unset( $GLOBALS['db'][ $n ] ); ++$k; } } return $k; }
function skyphusion_test_time() { return $GLOBALS['now']; }
define( 'SKYPHUSION_TRANSIENT_CLOCK', 'skyphusion_test_time' );
define( 'JS_OBJECT_CACHE_PERSIST_GROUPS', 'theme_json' ); // approach A's default allowlist
define( 'JS_OBJECT_CACHE_TTL', 10 );
require isset( $argv[1] ) ? $argv[1] : __DIR__ . '/../php/object-cache-js.php';

$fail = 0;
function check( $label, $cond ) {
	global $fail;
	echo ( $cond ? 'ok   ' : 'FAIL ' ) . $label . "\n";
	$fail += $cond ? 0 : 1;
}

// 1. The #1199 case: a permalink save sets settings_errors (30 s), the next request (a fresh runtime) reads it.
$r1 = new JS_Object_Cache();
$r1->set( 'settings_errors', array( array( 'code' => 'settings_updated' ) ), 'transient', 30 );
$r2 = new JS_Object_Cache();
$found = null;
$v = $r2->get( 'settings_errors', 'transient', false, $found );
check( 'a transient set in one runtime is read in a fresh one', $found === true && is_array( $v ) && 'settings_updated' === $v[0]['code'] );
check( 'stored as core stores it: _transient_settings_errors and its timeout row', isset( $GLOBALS['db']['_transient_settings_errors'] ) && $GLOBALS['db']['_transient_timeout_settings_errors'] === 1000030 );
check( 'written with autoload off (never in alloptions, so never in a stale cached alloptions)', 'off' === $GLOBALS['autoload']['_transient_settings_errors'] );

// 2. Expiry: past its timeout it is gone, and its rows are deleted (core's own rule).
$GLOBALS['now'] = 1000031;
$r3 = new JS_Object_Cache();
$found = null;
$r3->get( 'settings_errors', 'transient', false, $found );
check( 'an expired transient is a miss at once (its rows go when the request ends, #1210)', $found === false && isset( $GLOBALS['db']['_transient_settings_errors'] ) );
$r3->transient_flush();
check( '  and at the end of the request its rows are deleted', ! isset( $GLOBALS['db']['_transient_settings_errors'] ) && ! isset( $GLOBALS['db']['_transient_timeout_settings_errors'] ) );

// 3. No expiry: kept with no timeout row; updated in place; deleted for real.
$r4 = new JS_Object_Cache();
$r4->set( 'wc_count', 7, 'transient' );
$r4->set( 'wc_count', 8, 'transient' );
$r5 = new JS_Object_Cache();
check( 'a transient with no expiry survives, updated in place', 8 === $r5->get( 'wc_count', 'transient' ) && ! isset( $GLOBALS['db']['_transient_timeout_wc_count'] ) );
$r5->delete( 'wc_count', 'transient' );
$r5->transient_flush(); // the request ends (#1210)
$r6 = new JS_Object_Cache();
$found = null;
$r6->get( 'wc_count', 'transient', false, $found );
check( 'a deleted transient is gone in a fresh runtime', false === $found && ! isset( $GLOBALS['db']['_transient_wc_count'] ) );

// 4. Site transients: _site_transient_* rows.
$r7 = new JS_Object_Cache();
$r7->set( 'update_core', 'x', 'site-transient', 60 );
$r8 = new JS_Object_Cache();
check( 'a site transient survives too (_site_transient_update_core)', 'x' === $r8->get( 'update_core', 'site-transient' ) && isset( $GLOBALS['db']['_site_transient_update_core'] ) );

// 5. Never through the shared cross-request store (no stale cross-isolate copy), never via the bridge.
$GLOBALS['ops'] = array();
$r9 = new JS_Object_Cache();
$r9->set( 'lock', 1, 'transient', 5 );
$r9->get( 'lock', 'transient' );
check( 'transients make no bridge call (the database is the one store)', 0 === count( $GLOBALS['ops'] ) );

// 6. While WordPress installs (no tables yet) the old per-request behaviour holds.
$GLOBALS['installing'] = true;
$before = $GLOBALS['db'];
$r10 = new JS_Object_Cache();
$r10->set( 'during_install', 1, 'transient' );
check( 'while installing, nothing is written to the options table', $before === $GLOBALS['db'] && 1 === $r10->get( 'during_install', 'transient' ) );
$GLOBALS['installing'] = false;

// 7. Core's daily delete_expired_transients cron returns early with an external cache (delete_expired_transients(
// $force_db = false )), so expired rows nobody reads would pile up: the drop-in runs core's own cleanup on the database.
$src = file_get_contents( isset( $argv[1] ) ? $argv[1] : __DIR__ . '/../php/object-cache-js.php' );
check( 'the daily cleanup runs core delete_expired_transients( true ) (the rows live in the database now)', 1 === preg_match( "/add_action\\( 'delete_expired_transients', 'skyphusion_delete_expired_transients_db', 11 \\)/", $src ) && 1 === preg_match( '/function skyphusion_delete_expired_transients_db\\(\\) \\{\\s*delete_expired_transients\\( true \\);/', $src ) );

// 8. The cost (measured, #1199: 15 transient reads on a warm shop page, 14 on a product page, 36 on the dashboard, each
// a Hyperdrive query of about 14 ms). A request reads the site's learned transient names in ONE query at its first
// transient read, and serves every read after that from the request's own memory (never across requests: the next
// request reads the database again, so a write in another isolate is seen). The names are learned at shutdown into one
// autoloaded option, skyphusion_hot_transients, which arrives with alloptions.
$GLOBALS['db'] = array();
$GLOBALS['hot'] = null;
function skyphusion_test_hot_get() { return $GLOBALS['hot']; }
function skyphusion_test_hot_set( $v ) { $GLOBALS['hot'] = $v; }
define( 'SKYPHUSION_TRANSIENT_HOT_GET', 'skyphusion_test_hot_get' );
define( 'SKYPHUSION_TRANSIENT_HOT_SET', 'skyphusion_test_hot_set' );
$w = new JS_Object_Cache();
foreach ( array( 'a', 'b', 'c' ) as $n ) { $w->set( $n, 'v-' . $n, 'transient', 300 ); }
$w->set( 's', 'v-s', 'site-transient' );
$l = new JS_Object_Cache(); // a request that reads them and learns the names
foreach ( array( 'a', 'b', 'c' ) as $n ) { $l->get( $n, 'transient' ); }
$l->get( 's', 'site-transient' );
$l->get( 'absent', 'transient' );
$l->transient_learn();
check( 'the names read are learned (value rows, site transients included, absent ones too)', is_array( $GLOBALS['hot'] ) && 5 === count( $GLOBALS['hot'] ) && in_array( '_site_transient_s', $GLOBALS['hot'], true ) );
$GLOBALS['row_queries'] = 0;
$q = new JS_Object_Cache(); // the next request
$vals = array();
foreach ( array( 'a', 'b', 'c' ) as $n ) { $vals[] = $q->get( $n, 'transient' ); }
$vals[] = $q->get( 's', 'site-transient' );
$found = null;
$q->get( 'absent', 'transient', false, $found );
check( 'the next request reads all five in ONE query', 1 === $GLOBALS['row_queries'] );
check( 'with the right values, and the absent one a miss', array( 'v-a', 'v-b', 'v-c', 'v-s' ) === $vals && false === $found );
// A write in another isolate is seen by the next request (the memory is per request only).
$GLOBALS['db']['_transient_a'] = 'NEW';
$r = new JS_Object_Cache();
check( 'a write elsewhere is seen by the next request (no cross-request memory)', 'NEW' === $r->get( 'a', 'transient' ) );
// Within a request: its own write is read back, its delete is a miss, an expiry in the primed rows is honoured.
$r->set( 'b', 'mine', 'transient', 60 );
check( 'a request reads back its own write', 'mine' === $r->get( 'b', 'transient' ) );
$r->delete( 'c', 'transient' );
$found = null; $r->get( 'c', 'transient', false, $found );
check( 'a request sees its own delete', false === $found );
$r->transient_flush();
check( '  and its row is gone once the request ends', ! isset( $GLOBALS['db']['_transient_c'] ) );
$GLOBALS['now'] += 10000;
$e = new JS_Object_Cache();
$found = null; $e->get( 'a', 'transient', false, $found );
$e->transient_flush();
check( 'an expired row from the prime is a miss and is deleted', false === $found && ! isset( $GLOBALS['db']['_transient_a'] ) );
// Learning converges: a request that reads only listed names writes no list.
$GLOBALS['hot'] = array( '_transient_a' );
$c = new JS_Object_Cache();
$c->get( 'a', 'transient' );
$before = $GLOBALS['hot'];
$c->transient_learn();
check( 'no new names: the list is not written again', $before === $GLOBALS['hot'] );

// #1210: a request's transient deletes land in ONE statement at its end. strummer's qtrace of one guest order on
// cf759hl: 404 DELETE FROM wp_options WHERE option_name IN (?+) statements, one round trip each, 4,845 of 9,321 ms.
$GLOBALS['db'] = array(); $GLOBALS['hot'] = array(); $GLOBALS['delete_stmts'] = 0;
$GLOBALS['db']['_transient_wc_product_children_3'] = 'x';
$r = new JS_Object_Cache();
$q = $GLOBALS['row_queries'];
for ( $i = 0; $i < 404; $i++ ) {
	$r->delete( 'wc_product_children_' . ( $i % 250 ), 'transient' ); // 250 names, some deleted twice, as an order does
}
check( '#1210 404 deletes make no statement while the request runs', 0 === $GLOBALS['delete_stmts'] );
check( '#1210   and no read either (a delete is never a lookup)', $q === $GLOBALS['row_queries'] );
check( '#1210   the rows are still in the database until the end', isset( $GLOBALS['db']['_transient_wc_product_children_3'] ) );
$found = null; $r->get( 'wc_product_children_3', 'transient', false, $found );
check( '#1210 a tombstone: the request reads its own delete as a miss', false === $found );
$r->transient_flush();
check( '#1210 at the end: one statement per 400 names (500 distinct rows, repeats deduped: 2)', 2 === $GLOBALS['delete_stmts'] && ! isset( $GLOBALS['db']['_transient_wc_product_children_3'] ) );
check( '#1210 the flush is idempotent', 0 === $r->transient_flush() && 2 === $GLOBALS['delete_stmts'] );
// a set after a delete in the same request wins
$GLOBALS['db']['_transient_s'] = 'old'; $GLOBALS['db']['_transient_timeout_s'] = $GLOBALS['now'] + 50;
$r = new JS_Object_Cache();
$r->delete( 's', 'transient' );
$r->set( 's', 'new', 'transient' ); // no expiry: core leaves no timeout row after a delete
$r->delete( 't', 'transient' );
$r->set( 't', 'tv', 'transient', 30 );
check( '#1210 a set after a delete reads back in the request', 'new' === $r->get( 's', 'transient' ) );
$r->transient_flush();
check( '#1210 at the end the set row stands, and the deleted timeout row is gone', 'new' === $GLOBALS['db']['_transient_s'] && ! isset( $GLOBALS['db']['_transient_timeout_s'] ) );
check( '#1210   a set with an expiry keeps both its rows', 'tv' === $GLOBALS['db']['_transient_t'] && isset( $GLOBALS['db']['_transient_timeout_t'] ) );
// a set by ANOTHER request between this delete and the flush is deleted by the flush (accepted: it only removes cache)
$r = new JS_Object_Cache();
$r->delete( 'race', 'transient' );
$other = new JS_Object_Cache();
$other->set( 'race', 'theirs', 'transient' );
$r->transient_flush();
check( '#1210 a concurrent set before the flush is deleted (accepted: invalidation, rebuilt by its owner)', ! isset( $GLOBALS['db']['_transient_race'] ) );
// the answer: whether the value existed, when the request knows it; a row it never read answers false, no query
$GLOBALS['db']['_transient_known'] = 1;
$r = new JS_Object_Cache();
$r->get( 'known', 'transient' );
$q = $GLOBALS['row_queries'];
check( '#1210 delete of a value this request read: true', true === $r->delete( 'known', 'transient' ) );
check( '#1210 delete of a row it never read: true (deleted_transient fires, so a listener cascade runs), without a query', true === $r->delete( 'never_read', 'transient' ) && $q === $GLOBALS['row_queries'] );
$r->get( 'read_missing', 'transient' );
check( '#1210 delete of a row it read and found missing: false', false === $r->delete( 'read_missing', 'transient' ) );
$r->transient_flush();
// the hooks: the shutdown action at PHP_INT_MAX, and a PHP shutdown function for every other way a request ends
$src = file_get_contents( isset( $argv[1] ) ? $argv[1] : __DIR__ . '/../php/object-cache-js.php' );
check( '#1210 the flush is on the shutdown action, last', 1 === preg_match( "/add_action\\( 'shutdown', array\\( \\\$this, 'transient_flush' \\), PHP_INT_MAX \\);/", $src ) );
// a fatal error and an exit before WordPress's shutdown hook: a child PHP process, the real shutdown sequence
foreach ( array( 'fatal' => 'skyphusion_no_such_function();', 'exit' => 'exit( 0 );' ) as $how => $end ) {
	$log   = tempnam( sys_get_temp_dir(), 'oc1210' );
	$child = tempnam( sys_get_temp_dir(), 'oc1210' );
	file_put_contents( $child, '<?php
function post_message_to_js( $j ) { return json_encode( array( "ok" => true, "v" => array() ) ); }
function is_multisite() { return false; } function get_current_blog_id() { return 1; } function wp_installing() { return false; }
function get_option( $n, $d = false ) { return $d; } function update_option( $n, $v, $a = null ) { return true; }
function skyphusion_transient_rows( array $n ) { return array(); }
function skyphusion_transient_put( $n, $v ) { return true; }
function skyphusion_transient_delete( array $n ) { file_put_contents( ' . var_export( $log, true ) . ', implode( ",", $n ) . "\n", FILE_APPEND ); return count( $n ); }
require ' . var_export( isset( $argv[1] ) ? realpath( $argv[1] ) : realpath( __DIR__ . '/../php/object-cache-js.php' ), true ) . ';
$c = new JS_Object_Cache();
$c->delete( "gone", "transient" );
' . $end . "\n" );
	exec( escapeshellarg( PHP_BINARY ) . ' ' . escapeshellarg( $child ) . ' 2>/dev/null', $o, $rc );
	$got = trim( (string) file_get_contents( $log ) );
	check( "#1210 on $how, the pending deletes are flushed (rc $rc)", '_transient_gone,_transient_timeout_gone' === $got );
	unlink( $log ); unlink( $child );
}

echo $fail ? "$fail FAILED\n" : "ALL PASS\n";
exit( $fail ? 1 : 0 );
