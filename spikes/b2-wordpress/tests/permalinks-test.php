<?php
/**
 * #760: php/permalinks.php, with WordPress stubbed (no database).
 *   1. wp_install: an empty structure becomes the day-and-name structure stock's probe would keep, with a
 *      soft flush; a structure already set (any owner choice) is never touched. The core taxonomies are
 *      registered again AFTER the structure is set and BEFORE the flush: /_install runs wp_install outside
 *      wp-admin, where category and post_tag registered at init with no rewrite rules (WP_Taxonomy adds them
 *      only under is_admin() or a structure), so the flush stored rules with no /category/ or /tag/ archive
 *      and /?cat=1 redirected to a 404.
 *   1b. the one-time repair (#834): a site installed since #773 outside wp-admin has rules with no /category/ or
 *      /tag/ archive, and site update does not reinstall. On wp_loaded (every taxonomy registered), a site whose
 *      rewrite rules version is older flushes ONCE (soft) and records the version; the next request does not
 *      flush. An install records the version itself, so a new site never flushes again.
 *   2. parse_request (priority 5, before core's rest_api_loaded at 10): under plain, /wp-json and /wp-json/<x>
 *      set rest_route the way stock's ^wp-json/(.*)? rule does, under a subdirectory home too; a pretty
 *      structure, a rest_route already set, and a path that only starts with "wp-json" are left alone.
 * Run: php spikes/b2-wordpress/tests/permalinks-test.php
 */
$GLOBALS['opt']     = array( 'permalink_structure' => '' );
$GLOBALS['actions'] = array();
$GLOBALS['flushed'] = array();
$GLOBALS['events']  = array();
$GLOBALS['home']    = 'https://example.com/';
function get_option( $k, $d = false ) { return isset( $GLOBALS['opt'][ $k ] ) ? $GLOBALS['opt'][ $k ] : $d; }
function update_option( $k, $v, $autoload = null ) { $GLOBALS['opt'][ $k ] = $v; $GLOBALS['events'][] = 'version:' . $v; return true; }
function add_action( $h, $cb, $prio = 10 ) { $GLOBALS['actions'][ $h ] = array( $cb, $prio ); return true; }
$GLOBALS['filters'] = array();
function __return_true() { return true; } // core's, wp-includes/functions.php
function add_filter( $h, $cb, $prio = 10, $n = 1 ) { $GLOBALS['filters'][ $h ][] = $cb; return true; }
function flush_rewrite_rules( $hard = true ) { $GLOBALS['flushed'][] = $hard; $GLOBALS['events'][] = 'flush'; }
function create_initial_taxonomies() { $GLOBALS['events'][] = 'taxonomies:' . $GLOBALS['opt']['permalink_structure']; }
function wp_unslash( $v ) { return $v; }
function wp_parse_url( $u, $c = -1 ) { return parse_url( $u, $c ); }
function home_url( $p = '' ) { return rtrim( $GLOBALS['home'], '/' ) . $p; }
function rest_get_url_prefix() { return 'wp-json'; }
class Fake_Rewrite { public function set_permalink_structure( $s ) { $GLOBALS['opt']['permalink_structure'] = $s; $GLOBALS['events'][] = 'structure'; } }
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
ok( 'the core taxonomies are registered again with the structure set, before the flush (the category and tag rules)', array_slice( $GLOBALS['events'], 0, 3 ) === array( 'structure', 'taxonomies:/%year%/%monthnum%/%day%/%postname%/', 'flush' ) );
ok( '  and the install records the rules version (so a new site never repair-flushes)', array_slice( $GLOBALS['events'], 3 ) === array( 'version:' . SKYPHUSION_REWRITE_RULES_VERSION ) );
$GLOBALS['events'] = array(); $GLOBALS['flushed'] = array();
skyphusion_permalinks_repair();
ok( '  so the first request after the install does not flush', array() === $GLOBALS['flushed'] );
$GLOBALS['opt']['permalink_structure'] = '/%postname%/'; $GLOBALS['flushed'] = array(); $GLOBALS['events'] = array();
skyphusion_permalinks_on_install();
ok( 'already set: kept, no flush, nothing registered again', '/%postname%/' === $GLOBALS['opt']['permalink_structure'] && array() === $GLOBALS['flushed'] && array() === $GLOBALS['events'] );

// 1b. the one-time repair (#834)
ok( 'hooks wp_loaded (after every init, so every taxonomy is registered)', isset( $GLOBALS['actions']['wp_loaded'] ) );
$GLOBALS['opt'] = array( 'permalink_structure' => '/%year%/%monthnum%/%day%/%postname%/' ); $GLOBALS['events'] = array(); $GLOBALS['flushed'] = array();
skyphusion_permalinks_repair();
ok( 'a site with NO rules version (installed before this): ONE soft flush, then the version', array( 'flush', 'version:' . SKYPHUSION_REWRITE_RULES_VERSION ) === $GLOBALS['events'] && array( false ) === $GLOBALS['flushed'] );
$GLOBALS['events'] = array(); $GLOBALS['flushed'] = array();
skyphusion_permalinks_repair();
ok( 'the next request: no flush, nothing written', array() === $GLOBALS['events'] );
$GLOBALS['opt']['skyphusion_rewrite_rules_version'] = SKYPHUSION_REWRITE_RULES_VERSION - 1; $GLOBALS['events'] = array();
skyphusion_permalinks_repair();
ok( 'an OLDER version flushes once too', array( 'flush', 'version:' . SKYPHUSION_REWRITE_RULES_VERSION ) === $GLOBALS['events'] );
$GLOBALS['opt']['skyphusion_rewrite_rules_version'] = SKYPHUSION_REWRITE_RULES_VERSION + 1; $GLOBALS['events'] = array();
skyphusion_permalinks_repair();
ok( 'a NEWER version (a downgrade) does not flush', array() === $GLOBALS['events'] );
$GLOBALS['opt'] = array( 'permalink_structure' => '' ); $GLOBALS['events'] = array();
skyphusion_permalinks_repair();
ok( 'a plain site with no version flushes once as well (harmless; the rules include the REST mapping)', array( 'flush', 'version:' . SKYPHUSION_REWRITE_RULES_VERSION ) === $GLOBALS['events'] );

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
// #1345: got_url_rewrite(). The Worker routes every path that is not a file to index.php (as nginx try_files does), so
// pretty permalinks work with no index.php in them. Core decides from SERVER_SOFTWARE (Apache, nginx, Caddy, IIS),
// which php-wasm does not set, so got_url_rewrite() was false and options-permalink.php's "Post name" radio saved
// /index.php/%postname%/. There an all-digits slug misses the year-archive guard and answers 404 (gb navigation
// "can bind to a page", cf759hw 2026-11-22). Stock Apache saves /%postname%/.
$gur = $GLOBALS['filters']['got_url_rewrite'] ?? array();
ok( 'got_url_rewrite is filtered (the Worker rewrites every non-file path to index.php)', 1 === count( $gur ) );
ok( 'got_url_rewrite: true, whatever core computed from SERVER_SOFTWARE', 1 === count( $gur ) && true === call_user_func( $gur[0], false ) );
ok( 'got_mod_rewrite is NOT filtered (no .htaccess is written here)', empty( $GLOBALS['filters']['got_mod_rewrite'] ) );
echo $fails . " failing\n";
exit( $fails ? 1 : 0 );
