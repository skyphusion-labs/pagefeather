<?php
/**
 * REST route cache for the block editor's preload (b-dosql, issue #53).
 *
 * The editor preloads three theme routes on every post-new and edit page. Their
 * answers depend on files and settings that change rarely, and they were the
 * larger half of the editor's preload cost (docs/perf-dosql.md, #53):
 *   GET /wp/v2/global-styles/themes/<stylesheet>             theme origin data
 *   GET /wp/v2/global-styles/themes/<stylesheet>/variations  the theme's style variations
 *   GET /wp/v2/templates/lookup                               a template by slug
 * This keeps their answers in the object cache across requests.
 *
 * - On only with the object cache across requests (JS_OBJECT_CACHE, one object
 *   is the only writer) and with JS_ROUTE_CACHE (ROUTE_CACHE=off turns it off).
 * - It answers in rest_dispatch_request, which WordPress runs after the route's
 *   permission_callback. A cached answer never reaches a caller that the route
 *   would refuse. (A throwaway that answered in rest_pre_dispatch, which runs
 *   before the permission check, would have; #53.)
 * - It stores the route callback's own answer, before rest_request_after_callbacks.
 *   Filters after the callback still run on every answer.
 * - The key holds everything the answer is built from: the route and its query,
 *   the user, the WordPress version, the locale, the theme and its parent with
 *   their versions, the active plugins, the registered block types, and for
 *   templates/lookup the posts last_changed (any post or template write changes it).
 * - It fails safe: if a callback on a hook that changes these answers is not
 *   core's own (its source is not in wp-includes or wp-admin), or cannot be
 *   identified, the route is not cached.
 * - Each answer of these routes carries X-Route-Cache: hit, miss or bypass:<why>.
 */

if ( ! defined( 'JS_OBJECT_CACHE' ) || ! defined( 'JS_ROUTE_CACHE' ) ) {
	return;
}

class Skyphusion_Route_Cache {
	const GROUP = 'rest_route_cache';

	/** @var array<string, string> One state per request route seen in this PHP request. */
	public static $state = array();
	/** @var array<string, string> Cache key of a miss, to store after the callback. */
	public static $pending = array();

	/** Which of the three routes this is, or null. */
	public static function kind( $route ) {
		if ( preg_match( '#^/wp/v2/global-styles/themes/(?P<stylesheet>[\w-]+)(/variations)?$#', $route ) ) {
			return 'theme';
		}
		if ( '/wp/v2/templates/lookup' === $route ) {
			return 'lookup';
		}
		return null;
	}

	/** Hooks whose callbacks change the answers of a kind of route. */
	public static function hooks( $kind ) {
		$hooks = array( 'wp_theme_json_data_default', 'wp_theme_json_data_blocks', 'wp_theme_json_data_theme', 'wp_theme_json_data_user' );
		if ( 'lookup' === $kind ) {
			$hooks = array_merge( $hooks, array( 'default_template_types', 'default_template_part_areas', 'pre_get_block_templates', 'get_block_templates', 'pre_get_block_template', 'get_block_template', 'pre_get_block_file_template', 'get_block_file_template', 'rest_prepare_wp_template' ) );
			foreach ( array_keys( $GLOBALS['wp_filter'] ) as $name ) {
				if ( '_template_hierarchy' === substr( $name, -19 ) ) {
					$hooks[] = $name;
				}
			}
		}
		return $hooks;
	}

	/** The source file of a callback, or null when it cannot be identified. */
	public static function source( $cb ) {
		try {
			if ( is_string( $cb ) && false === strpos( $cb, '::' ) && function_exists( $cb ) ) {
				return ( new ReflectionFunction( $cb ) )->getFileName();
			}
			if ( $cb instanceof Closure ) {
				return ( new ReflectionFunction( $cb ) )->getFileName();
			}
			if ( is_string( $cb ) && false !== strpos( $cb, '::' ) ) {
				list( $class, $method ) = explode( '::', $cb, 2 );
				return ( new ReflectionMethod( $class, $method ) )->getFileName();
			}
			if ( is_array( $cb ) && 2 === count( $cb ) ) {
				return ( new ReflectionMethod( $cb[0], $cb[1] ) )->getFileName();
			}
		} catch ( ReflectionException $e ) {
			return null;
		}
		return null; // An invokable object or anything else: not identified.
	}

	/** Why this kind of route must not be cached now, or null. */
	public static function unsafe( $kind ) {
		$core = array( wp_normalize_path( ABSPATH . WPINC ) . '/', wp_normalize_path( ABSPATH . 'wp-admin' ) . '/' );
		foreach ( self::hooks( $kind ) as $hook ) {
			if ( empty( $GLOBALS['wp_filter'][ $hook ] ) ) {
				continue;
			}
			foreach ( $GLOBALS['wp_filter'][ $hook ]->callbacks as $callbacks ) {
				foreach ( $callbacks as $c ) {
					$file = self::source( $c['function'] );
					if ( null === $file || false === $file ) {
						return 'unidentified:' . $hook;
					}
					$file = wp_normalize_path( $file );
					if ( 0 !== strpos( $file, $core[0] ) && 0 !== strpos( $file, $core[1] ) ) {
						return 'filter:' . $hook;
					}
				}
			}
		}
		return null;
	}

	public static function key( $request, $kind ) {
		$query = $request->get_query_params();
		ksort( $query );
		$theme  = wp_get_theme();
		$parent = $theme->parent();
		$parts  = array(
			$request->get_route(),
			$query,
			get_current_user_id(),
			$GLOBALS['wp_version'],
			determine_locale(),
			get_stylesheet(),
			$theme->get( 'Version' ),
			get_template(),
			$parent ? $parent->get( 'Version' ) : '',
			(array) get_option( 'active_plugins', array() ),
			array_keys( WP_Block_Type_Registry::get_instance()->get_all_registered() ),
		);
		if ( 'lookup' === $kind ) {
			$parts[] = wp_cache_get_last_changed( 'posts' );
		}
		return 'r:' . md5( serialize( $parts ) );
	}
}

add_filter(
	'rest_dispatch_request',
	function ( $result, $request, $route, $handler ) {
		$kind = Skyphusion_Route_Cache::kind( $request->get_route() );
		if ( null !== $result || null === $kind || 'GET' !== $request->get_method() ) {
			return $result;
		}
		$route_key = $request->get_route();
		$why       = Skyphusion_Route_Cache::unsafe( $kind );
		if ( $why ) {
			Skyphusion_Route_Cache::$state[ $route_key ] = 'bypass:' . $why;
			return $result;
		}
		$key    = Skyphusion_Route_Cache::key( $request, $kind );
		$cached = wp_cache_get( $key, Skyphusion_Route_Cache::GROUP );
		if ( is_array( $cached ) ) {
			Skyphusion_Route_Cache::$state[ $route_key ] = 'hit';
			$response = new WP_REST_Response( $cached['data'], $cached['status'], $cached['headers'] );
			foreach ( $cached['links'] as $rel => $links ) {
				foreach ( $links as $link ) {
					$response->add_link( $rel, $link['href'], $link['attributes'] ?? array() );
				}
			}
			return $response;
		}
		Skyphusion_Route_Cache::$state[ $route_key ]   = 'miss';
		Skyphusion_Route_Cache::$pending[ $route_key ] = $key;
		return $result;
	},
	10,
	4
);

// The callback's own answer, before any rest_request_after_callbacks filter changes it.
add_filter(
	'rest_request_after_callbacks',
	function ( $response, $handler, $request ) {
		$route_key = $request->get_route();
		if ( empty( Skyphusion_Route_Cache::$pending[ $route_key ] ) ) {
			return $response;
		}
		$key = Skyphusion_Route_Cache::$pending[ $route_key ];
		unset( Skyphusion_Route_Cache::$pending[ $route_key ] );
		if ( $response instanceof WP_REST_Response && 200 === $response->get_status() ) {
			wp_cache_set(
				$key,
				array( 'data' => $response->get_data(), 'status' => 200, 'headers' => $response->get_headers(), 'links' => $response->get_links() ),
				Skyphusion_Route_Cache::GROUP
			);
		}
		return $response;
	},
	-PHP_INT_MAX,
	3
);

add_filter(
	'rest_post_dispatch',
	function ( $response, $server, $request ) {
		$route_key = $request->get_route();
		if ( isset( Skyphusion_Route_Cache::$state[ $route_key ] ) && $response instanceof WP_REST_Response ) {
			$response->header( 'X-Route-Cache', Skyphusion_Route_Cache::$state[ $route_key ] );
		}
		return $response;
	},
	10,
	3
);
