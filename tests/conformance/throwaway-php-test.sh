#!/bin/bash
# php/pf-conformance-throwaway.php (#759, #1401): the marker route, and the global-styles reset on stubbed WordPress.
#   bash tests/conformance/throwaway-php-test.sh
# The reset must delete every wp_global_styles post (any status) with its revisions, leave every other post alone,
# report what it deleted and what is left, and be open only to a user who can edit theme options.
set -u
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d "${TMPDIR:-/tmp}/pf-throwaway.XXXXXX"); trap 'rm -rf "$t"' EXIT
cat > "$t/harness.php" <<'PHP'
<?php
// A minimal stand-in for the WordPress functions the marker calls. $GLOBALS['pf_posts'] is the posts table:
// id => array( type, status, parent ).
$GLOBALS['pf_actions'] = array(); $GLOBALS['pf_routes'] = array(); $GLOBALS['pf_cleaned'] = 0;
$GLOBALS['pf_can'] = true; $GLOBALS['pf_undeletable'] = array();
function add_action( $hook, $cb ) { $GLOBALS['pf_actions'][ $hook ][] = $cb; }
function register_rest_route( $ns, $route, $args ) { $GLOBALS['pf_routes'][ $ns . $route ] = $args; }
function home_url() { return 'http://127.0.0.1'; }
function wp_parse_url( $u, $c ) { return parse_url( $u, $c ); }
function current_user_can( $cap ) { return 'edit_theme_options' === $cap && $GLOBALS['pf_can']; }
function get_post_stati() { return array( 'publish' => 1, 'draft' => 1, 'auto-draft' => 1, 'trash' => 1, 'inherit' => 1 ); }
function get_posts( $q ) {
	$out = array();
	foreach ( $GLOBALS['pf_posts'] as $id => $p ) {
		if ( $p['type'] !== $q['post_type'] ) { continue; }
		$st = $q['post_status'];
		if ( 'any' === $st ) { if ( in_array( $p['status'], array( 'trash', 'auto-draft' ), true ) ) { continue; } }
		elseif ( ! in_array( $p['status'], (array) $st, true ) ) { continue; }
		if ( isset( $q['post_parent__in'] ) && ! in_array( $p['parent'], $q['post_parent__in'], true ) ) { continue; }
		$out[] = $id;
	}
	return $out;
}
function wp_get_post_revisions( $id ) {
	$r = array();
	foreach ( $GLOBALS['pf_posts'] as $rid => $p ) { if ( 'revision' === $p['type'] && $p['parent'] === $id ) { $r[] = $rid; } }
	return $r;
}
function wp_delete_post( $id, $force ) {
	if ( in_array( $id, $GLOBALS['pf_undeletable'], true ) || ! isset( $GLOBALS['pf_posts'][ $id ] ) ) { return false; }
	foreach ( wp_get_post_revisions( $id ) as $rid ) { unset( $GLOBALS['pf_posts'][ $rid ] ); } // as core does
	unset( $GLOBALS['pf_posts'][ $id ] );
	return (object) array( 'ID' => $id );
}
class WP_Theme_JSON_Resolver { public static function clean_cached_data() { $GLOBALS['pf_cleaned']++; } }
function pf_site( $styles, $revs_per, $other_revs ) {
	$GLOBALS['pf_posts'] = array(); $id = 1;
	foreach ( $styles as $i => $status ) {
		$sid = $id++; $GLOBALS['pf_posts'][ $sid ] = array( 'type' => 'wp_global_styles', 'status' => $status, 'parent' => 0 );
		for ( $k = 0; $k < $revs_per[ $i ]; $k++ ) { $GLOBALS['pf_posts'][ $id++ ] = array( 'type' => 'revision', 'status' => 'inherit', 'parent' => $sid ); }
	}
	$oid = $id++; $GLOBALS['pf_posts'][ $oid ] = array( 'type' => 'post', 'status' => 'publish', 'parent' => 0 );
	for ( $k = 0; $k < $other_revs; $k++ ) { $GLOBALS['pf_posts'][ $id++ ] = array( 'type' => 'revision', 'status' => 'inherit', 'parent' => $oid ); }
	return $oid;
}
require $argv[1];
foreach ( $GLOBALS['pf_actions']['rest_api_init'] as $cb ) { $cb(); }
$routes = $GLOBALS['pf_routes'];
$case   = $argv[2];
$reset  = $routes['pf-conformance/v1/reset-global-styles'] ?? null;
if ( 'routes' === $case ) {
	$GLOBALS['pf_can'] = false; $denied = ( $reset['permission_callback'] )();
	$GLOBALS['pf_can'] = true;  $allowed = ( $reset['permission_callback'] )();
	echo json_encode( array( 'throwaway' => isset( $routes['pf-conformance/v1/throwaway'] ), 'method' => $reset['methods'] ?? null, 'denied' => $denied, 'allowed' => $allowed ) );
} elseif ( 'stale' === $case ) {
	$oid = pf_site( array( 'publish', 'draft' ), array( 44, 2 ), 3 );
	$r   = ( $reset['callback'] )();
	$r['other_kept'] = isset( $GLOBALS['pf_posts'][ $oid ] ) && 3 === count( wp_get_post_revisions( $oid ) );
	$r['cleaned']    = $GLOBALS['pf_cleaned'];
	echo json_encode( $r );
} elseif ( 'empty' === $case ) {
	pf_site( array(), array(), 1 );
	echo json_encode( ( $reset['callback'] )() );
} elseif ( 'stuck' === $case ) {
	pf_site( array( 'publish' ), array( 5 ), 0 );
	$GLOBALS['pf_undeletable'] = array( 1 );
	echo json_encode( ( $reset['callback'] )() );
}
PHP
fails=0
case_() { # case_ <label> <case> <want json>
  local got; got=$(php "$t/harness.php" "$here/php/pf-conformance-throwaway.php" "$2" 2>&1)
  if [ "$got" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1"; echo "  want $3"; echo "  got  $got"; fails=$((fails+1)); fi
}
case_ "both routes are registered; the reset is POST, refused without edit_theme_options, allowed with it" routes \
  '{"throwaway":true,"method":"POST","denied":false,"allowed":true}'
case_ "stale styles (a published post with 44 revisions, a draft with 2): all gone, reported; another post and its revisions kept; the theme.json cache cleared" stale \
  '{"reset":true,"posts":2,"revisions":46,"left_posts":0,"left_revisions":0,"other_kept":true,"cleaned":1}'
case_ "no styles post at all: nothing to delete, 0 left" empty \
  '{"reset":true,"posts":0,"revisions":0,"left_posts":0,"left_revisions":0}'
case_ "a post that will not delete is reported as left, never as reset clean" stuck \
  '{"reset":true,"posts":0,"revisions":5,"left_posts":1,"left_revisions":5}'
php -l "$here/php/pf-conformance-throwaway.php" >/dev/null || { echo "FAIL php -l"; fails=$((fails+1)); }
echo "$fails failing"
[ "$fails" = 0 ]
