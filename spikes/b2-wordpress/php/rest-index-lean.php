<?php
/**
 * Plugin Name: Lean REST index for the editor preload (#394 rank 3, #434)
 * Description: The block editor preloads the REST index as "/?_fields=<16 site fields>". Core's
 *   WP_REST_Server::get_index() builds 'routes' (get_data_for_routes over every registered route
 *   and its arguments) BEFORE _fields drops it, so each post-new and edit page paid for a list it
 *   never sends: +3.5 MiB of PHP memory without WooCommerce, the largest single preload route
 *   (pass Z, docs/design-434-admin-memory.md). More with WooCommerce, whose routes are in the list.
 *
 * For a GET of the route "/" with a _fields list that names none of routes, namespaces,
 * authentication, _links or _embedded (and no _embed), get_index() is given an empty endpoint list
 * (a rest_endpoints filter that returns array()), so it builds an empty 'routes' that _fields drops
 * anyway. The answer is the same, field for field.
 *
 * - The filter holds for that one callback only. It is added in rest_dispatch_request (after the
 *   route's permission check, dispatch already done) and removed in rest_index (the end of
 *   get_index) and in rest_request_after_callbacks (if get_index ends another way). Every other
 *   REST request in the same PHP request, a preload path or not, sees every endpoint.
 * - get_routes() keeps no cache: it re-reads the registered endpoints and re-applies the filter on
 *   every call (core 7.1.4), so nothing of the empty list outlives the callback.
 * - Fails safe: the full index when _fields is empty or names one of the fields above, when _embed
 *   is set, or when a callback on rest_index is not core's own (it may read 'routes'), or cannot be
 *   identified.
 * - Each answer of "/" carries X-Rest-Index: lean, or full:<why>. Under the operator memory trace
 *   (#435) each decision is also a mark (restindex:lean, restindex:full:<why>), and
 *   x-mem-off: restindex forces the full index for that request (an A/B in one build).
 * - SKYPHUSION_REST_INDEX_LEAN_OFF (a PHP constant) turns it off.
 * The same file runs on path a (approach A): it is one of the build's mu-plugins for both engines.
 */

if ( defined( 'SKYPHUSION_REST_INDEX_LEAN_OFF' ) && SKYPHUSION_REST_INDEX_LEAN_OFF ) {
	return;
}

final class Skyphusion_Rest_Index_Lean {
	/** _fields names that need the endpoint list, or that the full index builds beside it. */
	const NEEDS = array( 'routes', 'namespaces', 'authentication', '_links', '_embedded' );

	/** @var bool The empty endpoint filter is on now. */
	public static $on = false;
	/** @var string|null The decision for the "/" request being answered. */
	public static $state = null;

	public static function no_endpoints( $endpoints ) {
		return array();
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
		return null;
	}

	/** Why the index must be built in full for this request, or null for lean. */
	public static function why_full( $request ) {
		$off = isset( $GLOBALS['skyphusion_mem']['off'] ) && is_array( $GLOBALS['skyphusion_mem']['off'] ) ? $GLOBALS['skyphusion_mem']['off'] : array();
		if ( in_array( 'restindex', $off, true ) ) {
			return 'switch';
		}
		if ( $request->has_param( '_embed' ) ) {
			return 'embed';
		}
		$fields = wp_parse_list( $request['_fields'] ?? '' );
		if ( ! $fields ) {
			return 'no-fields';
		}
		foreach ( $fields as $f ) {
			$top = explode( '.', (string) $f, 2 )[0];
			if ( in_array( $top, self::NEEDS, true ) ) {
				return 'fields';
			}
		}
		if ( ! empty( $GLOBALS['wp_filter']['rest_index'] ) ) {
			$core = array( wp_normalize_path( ABSPATH . WPINC ) . '/', wp_normalize_path( ABSPATH . 'wp-admin' ) . '/' );
			$self = wp_normalize_path( __FILE__ );
			foreach ( $GLOBALS['wp_filter']['rest_index']->callbacks as $callbacks ) {
				foreach ( $callbacks as $c ) {
					$file = self::source( $c['function'] );
					if ( null === $file || false === $file ) {
						return 'hook-unidentified';
					}
					$file = wp_normalize_path( $file );
					if ( $file !== $self && 0 !== strpos( $file, $core[0] ) && 0 !== strpos( $file, $core[1] ) ) {
						return 'hook';
					}
				}
			}
		}
		return null;
	}

	public static function mark( $state ) {
		if ( function_exists( 'skyphusion_mem_mark' ) ) {
			skyphusion_mem_mark( 'restindex:' . $state );
		}
	}

	/** rest_dispatch_request: decide for "/" and, when lean, empty the endpoint list for its callback. */
	public static function dispatch( $result, $request, $route, $handler ) {
		if ( null !== $result || '/' !== $route || 'GET' !== $request->get_method() ) {
			return $result;
		}
		$why         = self::why_full( $request );
		self::$state = $why ? 'full:' . $why : 'lean';
		self::mark( self::$state );
		if ( ! $why ) {
			add_filter( 'rest_endpoints', array( __CLASS__, 'no_endpoints' ), PHP_INT_MAX );
			self::$on = true;
		}
		return $result;
	}

	/** Remove the empty endpoint filter. Safe to call when it is not on. */
	public static function off() {
		if ( self::$on ) {
			remove_filter( 'rest_endpoints', array( __CLASS__, 'no_endpoints' ), PHP_INT_MAX );
			self::$on = false;
		}
	}

	/** rest_index (the end of get_index), first: the list is back before any other callback runs. */
	public static function at_index( $response ) {
		self::off();
		return $response;
	}

	/** rest_request_after_callbacks: the list is back however the callback ended. */
	public static function after( $response ) {
		self::off();
		return $response;
	}

	/** rest_post_dispatch: tell the caller which index it got. */
	public static function header( $response, $server, $request ) {
		if ( null !== self::$state && '/' === $request->get_route() && $response instanceof WP_HTTP_Response ) {
			$response->header( 'X-Rest-Index', self::$state );
			self::$state = null;
		}
		return $response;
	}
}

add_filter( 'rest_dispatch_request', array( 'Skyphusion_Rest_Index_Lean', 'dispatch' ), PHP_INT_MAX, 4 );
add_filter( 'rest_index', array( 'Skyphusion_Rest_Index_Lean', 'at_index' ), PHP_INT_MIN );
add_filter( 'rest_request_after_callbacks', array( 'Skyphusion_Rest_Index_Lean', 'after' ), PHP_INT_MIN );
add_filter( 'rest_post_dispatch', array( 'Skyphusion_Rest_Index_Lean', 'header' ), 10, 3 );
