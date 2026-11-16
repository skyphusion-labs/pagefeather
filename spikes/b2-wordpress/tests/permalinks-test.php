<?php
/**
 * #760: php/permalinks.php, with WordPress stubbed (no database).
 *   1. wp_install: an empty structure becomes the day-and-name structure stock's probe would keep, with a
 *      soft flush; a structure already set (any owner choice) is never touched.
 *   2. parse_request (priority 5, before core's rest_api_loaded at 10): under plain, /wp-json and /wp-json/<x>
 *      set rest_route the way stock's ^wp-json/(.*)? rule does, under a subdirectory home too; a pretty
 *      structure, a rest_route already set, and a path that only starts with "wp-json" are left alone.
 * Run: php spikes/b2-wordpress/tests/permalinks-test.php
 */
$GLOBALS['opt']     = array( 'permalink_structure' => '' );
$GLOBALS['actions'] = array();
$GLOBALS['flushed'] = array();
$GLOBALS['home']    = 'https://example.com/';
function get_option( $k ) { return isset( $GLOBALS['opt'][ $k ] ) ? $GLOBALS['opt'][ $k ] : false; }
function add_action( $h, $cb, $prio = 10 ) { $GLOBALS['actions'][ $h ] = array( $cb, $prio ); return true; }
function flush_rewrite_rules( $hard = true ) { $GLOBALS['flushed'][] = $hard; }
function wp_unslash( $v ) { return $v; }
function wp_parse_url( $u, $c = -1 ) { return parse_url( $u, $c ); }
function home_url( $p = '' ) { return rtrim( $GLOBALS['home'], '/' ) . $p; }
function rest_get_url_prefix() { return 'wp-json'; }
class Fake_Rewrite { public function set_permalink_structure( $s ) { $GLOBALS['opt']['permalink_structure'] = $s; } }
class WP { public $query_vars = array(); }
$GLOBALS['wp_rewrite'] = new Fake_Rewrite();
require __DIR__ . '/../php/permalinks.php';

$fails = 0;
function ok( $label, $cond ) { global $fails; echo ( $cond ? 'PASS ' : 'FAIL ' ) . $label . "\n"; if ( ! $cond ) { $fails++; } }

// 1. install
ok( 'hooks wp_install', isset( $GLOBALS['actions']['wp_install'] ) );
skyphusion_permalinks_on_install();
ok( 'empty: the day-and-name structure', '/%year%/%monthnum%/%day%/%postname%/' === $GLOBALS['opt']['permalink_structure'] );
ok( 'and a soft flush (no .htaccess)', array( false ) === $GLOBALS['flushed'] );
$GLOBALS['opt']['permalink_structure'] = '/%postname%/'; $GLOBALS['flushed'] = array();
skyphusion_permalinks_on_install();
ok( 'already set: kept, no flush', '/%postname%/' === $GLOBALS['opt']['permalink_structure'] && array() === $GLOBALS['flushed'] );

// 2. parse_request
ok( 'hooks parse_request at priority 5 (before rest_api_loaded at 10)', isset( $GLOBALS['actions']['parse_request'] ) && 5 === $GLOBALS['actions']['parse_request'][1] );
function route( $uri, $structure = '', $preset = null, $home = 'https://example.com/' ) {
	$GLOBALS['opt']['permalink_structure'] = $structure; $GLOBALS['home'] = $home; $_SERVER['REQUEST_URI'] = $uri;
	$wp = new WP(); if ( null !== $preset ) { $wp->query_vars['rest_route'] = $preset; }
	skyphusion_permalinks_rest_route( $wp );
	return isset( $wp->query_vars['rest_route'] ) ? $wp->query_vars['rest_route'] : null;
}
ok( 'plain /wp-json/ -> /', '/' === route( '/wp-json/' ) );
ok( 'plain /wp-json -> /', '/' === route( '/wp-json' ) );
ok( 'plain /wp-json/wp/v2/posts?per_page=1 -> /wp/v2/posts (the query stays in $_GET)', '/wp/v2/posts' === route( '/wp-json/wp/v2/posts?per_page=1' ) );
ok( 'plain /wp-json/wc/v3/ -> /wc/v3/ (as the rule: /$1)', '/wc/v3/' === route( '/wp-json/wc/v3/' ) );
ok( 'plain, subdirectory home /blog: /blog/wp-json/wp/v2 -> /wp/v2', '/wp/v2' === route( '/blog/wp-json/wp/v2', '', null, 'https://example.com/blog/' ) );
ok( 'plain, subdirectory home: /wp-json/ outside it is left alone', null === route( '/wp-json/', '', null, 'https://example.com/blog/' ) );
ok( 'plain /wp-jsonx/ is left alone', null === route( '/wp-jsonx/' ) );
ok( 'plain / is left alone', null === route( '/' ) );
ok( 'pretty structure: left to the rewrite rule', null === route( '/wp-json/wp/v2', '/%postname%/' ) );
ok( 'a rest_route already set (?rest_route=) wins', '/x' === route( '/wp-json/wp/v2', '', '/x' ) );
echo $fails . " failing\n";
exit( $fails ? 1 : 0 );
