<?php
/**
 * Plugin Name: WooCommerce REST routes, registered on demand (#768)
 * Description: post-new.php alone took the PHP object from boot to the write ceiling (118 MiB): one of its largest
 *   lasting costs is the REST server's init, where WooCommerce registers 366 routes (WooCommerce 11.2.1: wc/v1 to v3,
 *   wc/pos, wc-admin, wc-admin-email, wc-push-notifications, wc-telemetry, wccom-site/v3, and the jetpack/v4 of the
 *   Jetpack packages it bundles), which the block editor's preload never asks for. Here those routes are DEFERRED,
 *   never removed: the route-only rest_api_init callbacks of the map below are taken off the hook and kept, and they
 *   run, once, in their order, the first time the request needs them, in rest_pre_dispatch (before route matching,
 *   so rest_do_request, rest_preload_api_request and a real REST call alike):
 *     - a route under /wc or /jetpack registers the namespace that route needs;
 *     - the full index "/" registers the whole map (a site-settings-only _fields list does not);
 *     - a route that still matches nothing registers the rest (a missed namespace is never a false 404).
 *   Settings and REST fields stay eager (their callbacks are not in the map), so the editor's preloaded settings are
 *   unchanged.
 *   SCOPE: post-new.php, post.php, admin.php, and admin-ajax.php (#963, #994).
 *   A REST path defers too, except the REST index (#987, #994).
 *   /wc and /jetpack defer, then register only the namespace the call needs.
 *   The REST index stays eager.
 *   The front end, cron, and every admin screen that is not admin.php stay eager.
 *   The map is of WooCommerce MAPPED_WOO.
 *   On any other version nothing is deferred.
 *   tests/wc-route-defer-test.sh fails until the map is checked again.
 *   Operator only (index.js passes it to PHP only with the spike token): x-pf-wc-defer: off turns it off on an editor
 *   screen (an A/B on one build); x-pf-wc-defer: force turns it on for any one request (the tests of on demand).
 *   A REST answer says what happened in X-PF-WC-Routes: deferred N/13 or registered M/13.
 *   N is how many mapped callbacks were found. M is how many ran.
 *   The editor preload still says deferred 13/13. off and unmapped <version> stay.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Skyphusion_WC_Route_Defer {
	const MAPPED_WOO = '11.2.1';
	/** The route-only rest_api_init callbacks of WooCommerce MAPPED_WOO (and its bundled Jetpack packages). */
	const DEFER = array(
		'Automattic\\WooCommerce\\RestApi\\Server::register_rest_routes',
		'Automattic\\WooCommerce\\Admin\\API\\Init::rest_api_init',
		'Automattic\\Jetpack\\Connection\\Manager::initialize_rest_api_registration_connector',
		'WC_Helper_Subscriptions_API::register_rest_routes',
		'WC_Brands::rest_api_register_routes',
		'WC_Helper_Admin::register_rest_routes',
		'Automattic\\WooCommerce\\Admin\\Features\\Blueprint\\Init::init_rest_api',
		'Automattic\\WooCommerce\\Internal\\Admin\\TaxSettingsRecommendations::register_routes',
		'Automattic\\WooCommerce\\Internal\\ProductFeed\\Integrations\\POSCatalog\\POSIntegration::rest_api_init',
		'Automattic\\Jetpack\\Connection\\Error_Handler::register_verify_error_endpoint',
		'Automattic\\Jetpack\\Heartbeat::initialize_rest_api',
		'WC_Helper_Orders_API::register_rest_routes',
		'WC_Admin_Marketplace_Promotions::register_rest_routes',
	);

	/** @var array<int, array{p:int, cb:array}> The kept callbacks, in the hook's order. */
	private static $kept    = array();
	private static $invoked = 0;
	private static $state   = '';
	public static $found    = array();

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'defer' ), PHP_INT_MIN );
		add_filter( 'rest_pre_dispatch', array( __CLASS__, 'on_demand' ), -1000, 3 );
		add_filter( 'rest_post_dispatch', array( __CLASS__, 'say' ), 10, 3 );
	}

	public static function owner( $f ) {
		if ( is_array( $f ) && isset( $f[0], $f[1] ) ) {
			return ( is_object( $f[0] ) ? get_class( $f[0] ) : (string) $f[0] ) . '::' . $f[1];
		}
		return is_string( $f ) ? $f : '';
	}

	/** Editor screens, admin.php (#994), admin-ajax (#963), a REST path except the index (#987, #994), or an operator force. */
	public static function in_scope() {
		if ( isset( $_SERVER['HTTP_X_PF_WC_DEFER'] ) && 'force' === $_SERVER['HTTP_X_PF_WC_DEFER'] ) {
			return true;
		}
		if ( defined( 'REST_REQUEST' ) && REST_REQUEST ) {
			$uri = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
			return self::rest_defers_uri( $uri );
		}
		if ( ! is_admin() ) {
			return false;
		}
		if ( wp_doing_ajax() ) {
			return true;
		}
		global $pagenow;
		return in_array( $pagenow, array( 'post-new.php', 'post.php', 'admin.php' ), true );
	}

	/**
	 * A REST URI defers except the index (#987, #994).
	 * /wc and /jetpack defer. on_demand registers the namespace the call needs.
	 * The index stays eager. A path that is not REST stays eager.
	 */
	public static function rest_defers_uri( $uri ) {
		$uri   = (string) $uri;
		$query = parse_url( $uri, PHP_URL_QUERY );
		if ( is_string( $query ) && preg_match( '/(?:^|&)rest_route=([^&]*)/', $query, $match ) ) {
			return self::rest_defers_route( rawurldecode( $match[1] ) );
		}
		$path = (string) parse_url( $uri, PHP_URL_PATH );
		if ( preg_match( '#/wp-json(/.*)?$#', $path, $match ) ) {
			$route = ( isset( $match[1] ) && '' !== $match[1] && '/' !== $match[1] ) ? $match[1] : '/';
			return self::rest_defers_route( $route );
		}
		return false;
	}

	/** True when this REST route skips the eager route table. The index cannot. */
	public static function rest_defers_route( $route ) {
		$route = '/' . ltrim( (string) $route, '/' );
		if ( '/' === $route ) {
			return false;
		}
		return true;
	}

	/**
	 * Callbacks one REST route needs. Null means the whole map.
	 * wc-admin and wc-analytics share one callback. /wc/* is the REST server.
	 * /jetpack is the bundled Jetpack callbacks. Anything else uses the whole map.
	 *
	 * @return array<int, string>|null
	 */
	public static function owners_for_route( $route ) {
		$route = '/' . ltrim( (string) $route, '/' );
		if ( preg_match( '#^/wc-admin(?:/|$)#', $route ) || preg_match( '#^/wc-analytics(?:/|$)#', $route ) ) {
			return array(
				'Automattic\\WooCommerce\\Admin\\API\\Init::rest_api_init',
			);
		}
		if ( preg_match( '#^/wc(?:/|$)#', $route ) ) {
			return array(
				'Automattic\\WooCommerce\\RestApi\\Server::register_rest_routes',
			);
		}
		if ( preg_match( '#^/jetpack(?:/|$)#', $route ) ) {
			return array(
				'Automattic\\Jetpack\\Connection\\Manager::initialize_rest_api_registration_connector',
				'Automattic\\Jetpack\\Connection\\Error_Handler::register_verify_error_endpoint',
				'Automattic\\Jetpack\\Heartbeat::initialize_rest_api',
			);
		}
		return null;
	}

	public static function defer() {
		if ( ! self::in_scope() ) {
			return; // out of scope: exactly as without this plugin
		}
		if ( ! defined( 'WC_VERSION' ) ) {
			self::$state = 'no-woocommerce';
			return;
		}
		if ( self::MAPPED_WOO !== WC_VERSION ) {
			self::$state = 'unmapped ' . WC_VERSION;
			return;
		}
		if ( isset( $_SERVER['HTTP_X_PF_WC_DEFER'] ) && 'off' === $_SERVER['HTTP_X_PF_WC_DEFER'] ) {
			self::$state = 'off';
			return;
		}
		global $wp_filter;
		if ( empty( $wp_filter['rest_api_init'] ) ) {
			return;
		}
		$want = array_flip( self::DEFER );
		foreach ( $wp_filter['rest_api_init']->callbacks as $prio => $cbs ) {
			foreach ( $cbs as $id => $cb ) {
				$o = self::owner( $cb['function'] );
				if ( '' === $o || ! isset( $want[ $o ] ) ) {
					continue;
				}
				self::$found[ $o ] = true;
				self::$kept[]      = array( 'p' => $prio, 'cb' => $cb );
				remove_action( 'rest_api_init', $cb['function'], $prio );
			}
		}
		self::$state = 'deferred ' . count( self::$found ) . '/' . count( self::DEFER );
	}

	/** Run the kept callbacks once, in their order, with the server. */
	public static function register_now() {
		self::register_owners( array_map( array( __CLASS__, 'kept_owner' ), self::$kept ) );
	}

	/** Owner string for one kept callback row. */
	public static function kept_owner( $k ) {
		return self::owner( $k['cb']['function'] );
	}

	/** Run these kept callbacks once, in their order, and leave the others kept. */
	public static function register_owners( $owners ) {
		if ( ! self::$kept || ! $owners ) {
			return;
		}
		$want = array_flip( (array) $owners );
		$run  = array();
		$left = array();
		foreach ( self::$kept as $k ) {
			$o = self::owner( $k['cb']['function'] );
			if ( isset( $want[ $o ] ) ) {
				$run[] = $k;
			} else {
				$left[] = $k;
			}
		}
		self::$kept = $left;
		if ( ! $run ) {
			return;
		}
		$server = rest_get_server();
		foreach ( $run as $k ) {
			$n = max( 1, (int) $k['cb']['accepted_args'] );
			call_user_func_array( $k['cb']['function'], array_slice( array( $server ), 0, $n ) );
			self::$invoked++;
		}
		self::$state = 'registered ' . self::$invoked . '/' . count( self::DEFER );
	}

	public static function route_matches( $server, $route ) {
		foreach ( array_keys( $server->get_routes() ) as $r ) {
			if ( preg_match( '@^' . $r . '$@i', (string) $route ) ) {
				return true;
			}
		}
		return false;
	}

	public static function needs_routes( $server, $request ) {
		$route = (string) $request->get_route();
		if ( '/' === $route || '' === $route ) {
			if ( ! isset( $request['_fields'] ) ) {
				return true;
			}
			foreach ( wp_parse_list( $request['_fields'] ) as $f ) {
				if ( in_array( strtok( (string) $f, '.' ), array( 'routes', 'namespaces', 'authentication', '_links' ), true ) ) {
					return true;
				}
			}
			return false;
		}
		if ( self::route_matches( $server, $route ) ) {
			return false;
		}
		return true; // matches nothing registered: the fail-safe
	}

	public static function on_demand( $result, $server, $request ) {
		if ( self::$kept && self::needs_routes( $server, $request ) ) {
			$want = self::owners_for_route( (string) $request->get_route() );
			if ( is_array( $want ) ) {
				self::register_owners( $want );
				if ( ! self::needs_routes( $server, $request ) ) {
					return $result;
				}
			}
			self::register_now();
		}
		return $result;
	}

	public static function say( $response, $server, $request ) {
		if ( '' !== self::$state && $response instanceof WP_REST_Response ) {
			$response->header( 'X-PF-WC-Routes', self::$state );
		}
		return $response;
	}
}

Skyphusion_WC_Route_Defer::init();
