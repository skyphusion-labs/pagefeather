<?php
/**
 * php/rest-index-lean.php against a REAL WordPress (#394 rank 3). run.sh builds the site; this runs
 * one case in-process (no web server) and prints one JSON line:
 *   php check.php <wp dir> compare      the editor's exact preload of "/" lean vs full, then the
 *                                       endpoint list for every later REST request (#394 condition 2)
 *   php check.php <wp dir> mem <lean|full>  PHP peak memory of that one preload call
 *   php check.php <wp dir> failsafe     the cases that must get the full index
 *   php check.php <wp dir> state        the X-Rest-Index of the editor's preload ("off" run: none)
 */
$site_dir = $argv[1]; // not $wp: that is WordPress's own global
$case     = $argv[2];
$_SERVER['HTTP_HOST']   = 'x.test';
$_SERVER['REQUEST_URI'] = '/';
require $site_dir . '/wp-load.php';
wp_set_current_user( 1 ); // the admin: the index adds image_sizes for a user who can upload

// The editor's exact _fields, read from core's own edit-form-blocks.php (so a core update that
// changes the list changes the test too).
$src = file_get_contents( ABSPATH . 'wp-admin/edit-form-blocks.php' );
if ( ! preg_match( "#'/\\?_fields=' \\. implode\\(\\s*',',\\s*array\\((.*?)\\)\\s*\\)#s", $src, $m ) ) {
	echo json_encode( array( 'error' => 'the editor preload of / was not found in edit-form-blocks.php' ) ), "\n";
	exit( 2 );
}
preg_match_all( "#'([a-z_]+)'#", $m[1], $f );
$path = '/?_fields=' . implode( ',', $f[1] );

function preload( $path, $full ) {
	$GLOBALS['skyphusion_mem']['off'] = $full ? array( 'restindex' ) : array();
	$memo = rest_preload_api_request( array(), $path );
	return $memo[ $path ] ?? null;
}
function route_count() {
	return count( rest_get_server()->get_routes() );
}
function lean_filter_on() {
	return false !== has_filter( 'rest_endpoints', array( 'Skyphusion_Rest_Index_Lean', 'no_endpoints' ) );
}

$out = array( 'case' => $case, 'fields' => count( $f[1] ) );
if ( 'compare' === $case ) {
	// The baseline is taken AFTER a full preload: WooCommerce registers more routes after its first
	// dispatch (574, then 663, measured locally), so a count from before it is not comparable.
	$full   = preload( $path, true );
	$before = route_count();
	$lean   = preload( $path, false );
	$out['routes']        = $before;
	$out['namespaces']    = array_values( rest_get_server()->get_namespaces() );
	$out['bodyEqual']     = null !== $full && null !== $lean && json_encode( $full['body'] ) === json_encode( $lean['body'] );
	$out['bodyKeys']      = $lean ? array_keys( $lean['body'] ) : null;
	$out['stateFull']     = $full['headers']['X-Rest-Index'] ?? null;
	$out['stateLean']     = $lean['headers']['X-Rest-Index'] ?? null;
	$hf = $full['headers'] ?? array(); $hl = $lean['headers'] ?? array();
	unset( $hf['X-Rest-Index'], $hl['X-Rest-Index'] );
	$out['headersEqualOtherwise'] = json_encode( $hf ) === json_encode( $hl );
	// Condition 2: every later REST request in this PHP request sees every endpoint.
	$out['filterLeftOn']  = lean_filter_on();
	$out['routesAfter']   = route_count();
	$idx                  = rest_do_request( new WP_REST_Request( 'GET', '/' ) ); // a full index, no _fields
	$out['fullIndexRoutes'] = count( $idx->get_data()['routes'] ?? array() );
	$types                = rest_do_request( new WP_REST_Request( 'GET', '/wp/v2/types' ) );
	$out['typesStatus']   = $types->get_status();
	// A request for a route that exists only in a plugin namespace still matches its handler.
	$ns = array_values( array_filter( $out['namespaces'], function ( $n ) { return 0 !== strpos( $n, 'wp/' ) && 'oembed/1.0' !== $n; } ) );
	if ( $ns ) {
		$r = rest_do_request( new WP_REST_Request( 'GET', '/' . $ns[0] ) );
		$out['pluginNamespace'] = array( $ns[0], $r->get_status() );
	}
} elseif ( 'mem' === $case ) {
	$full = 'full' === ( $argv[3] ?? '' );
	rest_get_server(); // the server and its routes are set up before the measured call
	$GLOBALS['skyphusion_mem']['off'] = $full ? array( 'restindex' ) : array();
	$base = memory_get_usage();
	memory_reset_peak_usage();
	rest_preload_api_request( array(), $path );
	$out['mode']        = $full ? 'full' : 'lean';
	$out['peakOverKiB'] = (int) round( ( memory_get_peak_usage() - $base ) / 1024 );
} elseif ( 'failsafe' === $case ) {
	$st = function ( $p, $extra = null ) {
		$GLOBALS['skyphusion_mem']['off'] = array();
		if ( $extra ) {
			$extra();
		}
		$r = rest_preload_api_request( array(), $p );
		return $r[ $p ]['headers']['X-Rest-Index'] ?? null;
	};
	$out['routesField']  = $st( '/?_fields=name,routes' );
	$out['linksField']   = $st( '/?_fields=name,_links' );
	$out['nestedRoutes'] = $st( '/?_fields=name,routes.foo' );
	$out['noFields']     = $st( '/' );
	$out['embed']        = $st( '/?_fields=name&_embed=1' );
	$out['foreignHook']  = $st( $path, function () { add_filter( 'rest_index', function ( $r ) { return $r; } ); } );
	$out['otherRoute']   = ( rest_preload_api_request( array(), '/wp/v2/types' )['/wp/v2/types']['headers']['X-Rest-Index'] ?? null );
	$out['filterLeftOn'] = lean_filter_on();
} elseif ( 'state' === $case ) {
	$r = preload( $path, false );
	$out['state']  = $r['headers']['X-Rest-Index'] ?? null;
	// The class is declared at compile time either way; what the constant stops is the hooks.
	$out['hooked'] = false !== has_filter( 'rest_dispatch_request', array( 'Skyphusion_Rest_Index_Lean', 'dispatch' ) );
}
echo json_encode( $out ), "\n";
