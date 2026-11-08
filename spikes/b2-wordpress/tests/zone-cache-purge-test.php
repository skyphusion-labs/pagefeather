<?php
// php tests/zone-cache-purge-test.php
// Unit test for php/zone-cache-purge.php with minimal WordPress stubs. Checks the
// URL collection, the dedupe, the one-call-per-request debounce (shutdown flush),
// and the theme-wide everything path.

$fail = 0;
function check( $label, $got, $want ) {
	global $fail;
	if ( $got === $want ) { echo "ok   $label\n"; return; }
	$fail++; echo "FAIL $label\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
}

// ---- The gate the Worker injects, and the worker-call capture. ----
define( 'SKYPHUSION_CACHE_PURGE', true );
$GLOBALS['worker_calls'] = array();
function skyphusion_worker_call( $json ) {
	$GLOBALS['worker_calls'][] = json_decode( $json, true );
	return '{}';
}

// ---- Minimal WordPress stubs. ----
$GLOBALS['hooks'] = array();
function add_action( $hook, $cb, $prio = 10, $args = 1 ) {
	$GLOBALS['hooks'][ $hook ][] = $cb;
}
function do_action( $hook, ...$args ) {
	foreach ( $GLOBALS['hooks'][ $hook ] ?? array() as $cb ) {
		call_user_func_array( $cb, $args );
	}
}
function wp_json_encode( $v ) { return json_encode( $v ); }
function home_url( $path = '/' ) { return 'https://x.test' . $path; }
function get_permalink( $id ) { return 'https://x.test/?p=' . (int) $id; }
function get_feed_link() { return 'https://x.test/feed/'; }
function get_post_comments_feed_link( $id ) { return 'https://x.test/?p=' . (int) $id . '&feed=comments'; }
function post_type_exists( $t ) { return true; }
function is_post_type_viewable( $t ) { return 'post' === $t || 'page' === $t; }
function get_comment( $id ) { $c = new stdClass(); $c->comment_post_ID = 7; return $c; }

class WP_Post {
	public $ID;
	public $post_type;
	public function __construct( $id, $type ) { $this->ID = $id; $this->post_type = $type; }
}

require __DIR__ . '/../php/zone-cache-purge.php';

// Helper: run the shutdown flush, then return and clear the captured calls.
function flush_and_take() {
	do_action( 'shutdown' );
	$c = $GLOBALS['worker_calls'];
	$GLOBALS['worker_calls'] = array();
	return $c;
}

// 1) Publishing a post queues permalink + home + feed + comments feed, once.
do_action( 'transition_post_status', 'publish', 'draft', new WP_Post( 1, 'post' ) );
// A second change to the SAME post in one request must not duplicate.
do_action( 'transition_post_status', 'publish', 'publish', new WP_Post( 1, 'post' ) );
$calls = flush_and_take();
check( 'one purge call for the request', count( $calls ), 1 );
check(
	'deduped permalink + home + feed + comments feed',
	$calls[0],
	array( 'purgeZone' => array( 'files' => array(
		'https://x.test/?p=1',
		'https://x.test/',
		'https://x.test/feed/',
		'https://x.test/?p=1&feed=comments',
	) ) )
);

// 2) A status change that neither enters nor leaves publish queues nothing.
do_action( 'transition_post_status', 'draft', 'pending', new WP_Post( 2, 'post' ) );
check( 'no purge for a non-publish transition', flush_and_take(), array() );

// 3) A non-viewable post type queues nothing.
do_action( 'transition_post_status', 'publish', 'draft', new WP_Post( 3, 'revision' ) );
check( 'no purge for a non-viewable type', flush_and_take(), array() );

// 4) A theme switch purges the whole zone, and everything wins over any URLs.
do_action( 'transition_post_status', 'publish', 'draft', new WP_Post( 4, 'post' ) );
do_action( 'switch_theme' );
$calls = flush_and_take();
check( 'theme switch is one call', count( $calls ), 1 );
check( 'theme switch purges everything', $calls[0], array( 'purgeZone' => array( 'everything' => true ) ) );

// 5) An approved comment purges its post; a held one does not.
do_action( 'comment_post', 100, 1 );
$calls = flush_and_take();
check( 'approved comment purges the post', isset( $calls[0]['purgeZone']['files'] ) && in_array( 'https://x.test/?p=7', $calls[0]['purgeZone']['files'], true ), true );
do_action( 'comment_post', 101, 0 );
check( 'held comment does not purge', flush_and_take(), array() );

echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
exit( $fail ? 1 : 0 );
