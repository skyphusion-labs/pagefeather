<?php
/**
 * #772: php/plain-404.php's rule, skyphusion_plain_404_path(), and its hook (WordPress stubbed).
 * Run: php spikes/b2-wordpress/tests/plain-404-test.php
 */
$GLOBALS['actions'] = array(); $GLOBALS['filters'] = array();
function add_action( $h, $cb, $p = 10 ) { $GLOBALS['actions'][ $h ] = array( $cb, $p ); }
function add_filter( $h, $cb ) { $GLOBALS['filters'][] = $h; }
function wp_unslash( $v ) { return $v; }
function wp_parse_url( $u, $c = -1 ) { return parse_url( $u, $c ); }
function home_url( $p = '' ) { return 'https://example.com' . $p; }
function get_option( $k ) { return $GLOBALS['structure']; }
class WP { public $query_vars = array( 'p' => '1' ); }
require __DIR__ . '/../php/plain-404.php';
$fails = 0;
function ok( $l, $c ) { global $fails; echo ( $c ? 'PASS ' : 'FAIL ' ) . $l . "\n"; if ( ! $c ) { $fails++; } }
$is = function ( $uri, $structure = '', $script = '/index.php', $home = '/' ) { return skyphusion_plain_404_path( $structure, $uri, $script, $home ); };
foreach ( array( '/no-such-thing', '/no-such-thing/', '/no-such-thing?p=1', '/robots.txt', '/wp-sitemap.xml', '/hello', '/wp-json/wp/v2/posts' ) as $u ) {
	ok( "plain, unknown $u: 404", $is( $u ) );
}
foreach ( array( '/', '/?p=1', '/?feed=rss2', '/?wc-ajax=get_refreshed_fragments', '/index.php', '/index.php?p=1', '/index.php/foo', '' ) as $u ) {
	ok( "plain, $u: untouched", ! $is( $u ) );
}
ok( 'a pretty structure: untouched', ! $is( '/no-such-thing', '/%postname%/' ) );
ok( 'another script (wp-login.php): untouched', ! $is( '/wp-login.php', '', '/wp-login.php' ) );
ok( 'subdirectory home /blog: /blog/x is a 404', $is( '/blog/x', '', '/blog/index.php', '/blog/' ) );
ok( '  /blog/ and /blog are not', ! $is( '/blog/', '', '/blog/index.php', '/blog/' ) && ! $is( '/blog', '', '/blog/index.php', '/blog/' ) );
ok( '  /blog/index.php is not', ! $is( '/blog/index.php', '', '/blog/index.php', '/blog/' ) );
// the hook
ok( 'hooks parse_request at 20 (after rest_api_loaded at 10)', isset( $GLOBALS['actions']['parse_request'] ) && 20 === $GLOBALS['actions']['parse_request'][1] );
$GLOBALS['structure'] = ''; $_SERVER['REQUEST_URI'] = '/no-such-thing?p=1'; $_SERVER['SCRIPT_NAME'] = '/index.php';
$wp = new WP(); skyphusion_plain_404( $wp );
ok( 'an unknown path: query vars become error=404 only', array( 'error' => '404' ) === $wp->query_vars );
ok( '  and canonical redirects are off for it', in_array( 'redirect_canonical', $GLOBALS['filters'], true ) && in_array( 'do_redirect_guess_404_permalink', $GLOBALS['filters'], true ) );
$GLOBALS['filters'] = array(); $_SERVER['REQUEST_URI'] = '/?p=1';
$wp = new WP(); skyphusion_plain_404( $wp );
ok( 'a query-only URL: query vars and redirects untouched', array( 'p' => '1' ) === $wp->query_vars && array() === $GLOBALS['filters'] );
echo $fails . " failing\n";
exit( $fails ? 1 : 0 );
