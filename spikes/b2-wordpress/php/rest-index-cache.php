<?php
/**
 * Plugin Name: REST index cache (#1020)
 * Description: The REST index (GET /wp-json/) answered from a stored copy, so the request skips WooCommerce's route
 *   registration and the index build.
 *
 * Why. On approach A, PHP runs in the Worker isolate and shares its 128 MiB with the JS heap. GET /wp-json/ took the
 * fresh PHP heap from 69 to 108 MiB (lean, measured locally on #1020): WooCommerce's rest_api_init registers 366
 * routes and loads about 280 files (about 19 MiB), and the index build adds 4 MiB. cf759h answered 1102
 * exceededMemory in 5 of 6 tries.
 *
 * What. Only the BARE index: GET, the route "/", and no query parameter but rest_route (no _fields, _embed, context,
 * _envelope, _jsonp, _pretty). Everything else is exactly as without this plugin.
 *   - A miss runs as before. Its JSON body and its response headers are stored, as WordPress echoed them.
 *   - wc-route-defer defers WooCommerce's routes for the bare index (defers_index). A miss registers them all on
 *     demand before get_index, as for any other REST call that needs them.
 *   - A hit: in rest_pre_dispatch, for the main request only, a response with the stored headers takes the place of
 *     get_index, and rest_pre_serve_request echoes the stored body. No WooCommerce route is registered. Authentication still runs first: bad credentials still get their error, and the cookie nonce and
 *     CORS headers still come from WordPress. rest_post_dispatch filters still run on the answer.
 * The key. A stored body is only reused for the same USER (the index is per user: WordPress adds image_sizes and the
 * active theme link for a user who may upload or edit the theme; guests share one copy), the same build
 * (SKYPHUSION_BUILD_ID; a code-locked site changes code only on deploy), WordPress and WooCommerce versions, locale,
 * active plugins (so a plugin activate or deactivate misses), theme, and each site option the index prints. Without
 * SKYPHUSION_BUILD_ID nothing is cached. The user is read again after REST authentication (a cookie with no nonce is
 * a guest there), and the hit is decided only then; a miss after the deferral still gets every route through
 * wc-route-defer's on-demand registration.
 * Expiry 600 s. That bounds one known stale class: a plugin that registers routes from its own database settings
 * (a post type made in an admin screen, for example) changes the index without a deploy or a plugin change.
 * Test: tests/rest-index-cache-test.php, tests/rest-index-cache-e2e.sh.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Skyphusion_Rest_Index_Cache {
	const GROUP = 'skyphusion_rest_index';
	const TTL   = 600;
	/** The site options get_index prints, plus the permalink structure its links use. */
	const OPTIONS = array( 'blogname', 'blogdescription', 'siteurl', 'home', 'gmt_offset', 'timezone_string', 'page_for_posts', 'page_on_front', 'show_on_front', 'site_logo', 'site_icon', 'permalink_structure', 'active_plugins', 'stylesheet', 'template' );

	/** @var array|false|null The stored copy for this request: null not looked up, false none. */
	private static $hit = null;
	/** @var bool The next dispatch is the main request (set by its authentication check). */
	private static $main_next = false;
	/** @var bool This request served the stored copy. */
	public static $served = false;
	/** @var bool wc-route-defer deferred WooCommerce's routes on this request's stored copy. */
	private static $deferred = false;
	/** @var array|null Headers of the main miss answer, kept for the store. */
	private static $miss_headers = null;

	/**
	 * Whether a request is the bare index: GET, route "/", no query parameter but rest_route.
	 *
	 * @param string $method REQUEST_METHOD.
	 * @param string $uri    REQUEST_URI.
	 * @return bool
	 */
	public static function bare_index( $method, $uri ) {
		if ( 'GET' !== strtoupper( (string) $method ) ) {
			return false;
		}
		$uri   = (string) $uri;
		$path  = (string) parse_url( $uri, PHP_URL_PATH );
		$query = (string) parse_url( $uri, PHP_URL_QUERY );
		$args  = array();
		if ( '' !== $query ) {
			parse_str( $query, $args );
		}
		$route = null;
		if ( array_key_exists( 'rest_route', $args ) ) {
			$route = is_string( $args['rest_route'] ) ? $args['rest_route'] : null;
			unset( $args['rest_route'] );
		} elseif ( preg_match( '#/wp-json/?$#', $path ) ) {
			$route = '/';
		}
		if ( null === $route || '/' !== '/' . ltrim( $route, '/' ) || array() !== $args ) {
			return false;
		}
		return true;
	}

	/**
	 * The cache key: everything the stored index is built from. Pure, for the test.
	 *
	 * @param array $parts build, versions, locale, sitewide plugins, and each OPTIONS value.
	 * @return string
	 */
	public static function key_of( array $parts ) {
		ksort( $parts );
		return 'v1:' . md5( serialize( $parts ) );
	}

	/** The key for this site now, or null when the build id is not known. */
	public static function key() {
		if ( ! defined( 'SKYPHUSION_BUILD_ID' ) || '' === (string) SKYPHUSION_BUILD_ID ) {
			return null;
		}
		$parts = array(
			'build'    => (string) SKYPHUSION_BUILD_ID,
			'wp'       => isset( $GLOBALS['wp_version'] ) ? (string) $GLOBALS['wp_version'] : '',
			'wc'       => defined( 'WC_VERSION' ) ? WC_VERSION : '',
			'locale'   => function_exists( 'get_locale' ) ? get_locale() : '',
			'sitewide' => is_multisite() ? get_site_option( 'active_sitewide_plugins' ) : null,
			'user'     => function_exists( 'get_current_user_id' ) ? get_current_user_id() : 0,
			'ulocale'  => function_exists( 'get_user_locale' ) ? get_user_locale() : '',
		);
		foreach ( self::OPTIONS as $o ) {
			$parts[ 'o:' . $o ] = get_option( $o );
		}
		// The SET of active plugins: deactivate_plugins leaves the list re-indexed, and the order does not change routes.
		if ( is_array( $parts['o:active_plugins'] ) ) {
			$list = array_values( $parts['o:active_plugins'] );
			sort( $list );
			$parts['o:active_plugins'] = $list;
		}
		return self::key_of( $parts );
	}

	/**
	 * Whether wc-route-defer may defer WooCommerce's routes for this request. Only a request that carries NO
	 * credentials (no Authorization header, no logged-in cookie): it is a guest at rest_api_init and at dispatch alike,
	 * so the copy found now is the copy it gets (pre_dispatch serves it, never a rebuilt index). An index built after a
	 * deferral is NOT the eager index (measured: the namespace order differs and two wc-analytics routes are missing),
	 * so a request that might miss is never deferred: a request with credentials registers eagerly, and a hit then
	 * skips only the index build.
	 */
	public static function defers_index() {
		if ( self::has_credentials( $_SERVER, $_COOKIE ) ) {
			return false;
		}
		if ( false === self::stored() ) {
			return false;
		}
		self::$deferred = true;
		return true;
	}

	/**
	 * Whether a request carries credentials WordPress may turn into a user. Pure, for the test.
	 *
	 * @param array $server $_SERVER.
	 * @param array $cookie $_COOKIE.
	 * @return bool
	 */
	public static function has_credentials( $server, $cookie ) {
		foreach ( array( 'HTTP_AUTHORIZATION', 'REDIRECT_HTTP_AUTHORIZATION', 'PHP_AUTH_USER', 'PHP_AUTH_PW' ) as $h ) {
			if ( ! empty( $server[ $h ] ) ) {
				return true;
			}
		}
		foreach ( array_keys( (array) $cookie ) as $c ) {
			if ( 0 === strpos( (string) $c, 'wordpress_' ) || 0 === strpos( (string) $c, 'wp-' ) ) {
				return true;
			}
		}
		return false;
	}

	/** Whether this request is the bare index. */
	public static function this_request_is_index() {
		$method = isset( $_SERVER['REQUEST_METHOD'] ) ? (string) $_SERVER['REQUEST_METHOD'] : '';
		$uri    = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
		return self::bare_index( $method, $uri );
	}

	/**
	 * The stored copy for this request, or false. $again looks it up again (after REST authentication, when the
	 * user is final); otherwise the first answer is kept (rest_api_init, for the route deferral).
	 */
	public static function stored( $again = false ) {
		if ( null !== self::$hit && ! $again ) {
			return self::$hit;
		}
		self::$hit = false;
		if ( ! self::this_request_is_index() ) {
			return false;
		}
		$key = self::key();
		if ( null === $key ) {
			return false;
		}
		$v = wp_cache_get( $key, self::GROUP );
		if ( is_array( $v ) && isset( $v['body'], $v['headers'] ) && is_string( $v['body'] ) && is_array( $v['headers'] ) ) {
			self::$hit = $v;
		}
		return self::$hit;
	}

	public static function init() {
		add_filter( 'rest_authentication_errors', array( __CLASS__, 'mark_main' ), PHP_INT_MAX );
		add_filter( 'rest_pre_dispatch', array( __CLASS__, 'pre_dispatch' ), -2000, 3 );
		add_filter( 'rest_post_dispatch', array( __CLASS__, 'post_dispatch' ), PHP_INT_MAX, 3 );
		add_filter( 'rest_pre_serve_request', array( __CLASS__, 'serve' ), PHP_INT_MAX, 4 );
		add_filter( 'rest_pre_echo_response', array( __CLASS__, 'store' ), PHP_INT_MAX, 3 );
	}

	/** WP_REST_Server::check_authentication runs this just before the main dispatch. */
	public static function mark_main( $errors ) {
		self::$main_next = true;
		return $errors;
	}

	/** True once, for the first dispatch after the main authentication check. */
	private static function take_main() {
		$m               = self::$main_next;
		self::$main_next = false;
		return $m;
	}

	public static function pre_dispatch( $result, $server, $request ) {
		if ( ! self::take_main() || ! empty( $result ) || '/' !== $request->get_route() || ! self::this_request_is_index() ) {
			return $result;
		}
		// A deferred request (no credentials) gets the copy found at rest_api_init. Any other request looks up again,
		// now that REST authentication has made the user final; its routes are eager, so a miss is the eager index.
		$v = self::$deferred ? self::$hit : self::stored( true );
		if ( ! $v ) {
			if ( ! self::$deferred ) {
				self::$miss_headers = array(); // store only from an eager build
			}
			return $result;
		}
		$r = new WP_REST_Response( array(), 200, $v['headers'] );
		$r->set_matched_route( '/' );
		$r->header( 'X-PF-Rest-Index', 'hit' );
		self::$served = true;
		return $r;
	}

	public static function post_dispatch( $response, $server, $request ) {
		if ( is_array( self::$miss_headers ) ) {
			// Only a 200 is stored; anything else is never reused. The stored headers are WordPress's own (taken
			// before our X-PF-Rest-Index header is added).
			self::$miss_headers = ( $response instanceof WP_HTTP_Response && 200 === $response->get_status() ) ? $response->get_headers() : null;
			if ( is_array( self::$miss_headers ) ) {
				$response->header( 'X-PF-Rest-Index', 'miss' );
			}
		}
		return $response;
	}

	public static function serve( $served, $result, $request, $server ) {
		if ( $served || ! self::$served ) {
			return $served;
		}
		echo self::$hit['body']; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- WordPress's own JSON, stored
		return true;
	}

	public static function store( $result, $server, $request ) {
		if ( ! is_array( self::$miss_headers ) || '/' !== $request->get_route() ) {
			return $result;
		}
		$headers            = self::$miss_headers;
		self::$miss_headers = null;
		$key                = self::key();
		$body               = wp_json_encode( $result, apply_filters( 'rest_json_encode_options', 0, $request ) );
		if ( null !== $key && is_string( $body ) && '' !== $body ) {
			wp_cache_set( $key, array( 'body' => $body, 'headers' => $headers ), self::GROUP, self::TTL );
		}
		return $result;
	}
}

Skyphusion_Rest_Index_Cache::init();
