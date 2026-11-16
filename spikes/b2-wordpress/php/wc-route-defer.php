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
 *     - a route under /wc or /jetpack;
 *     - the full index "/" (the editor's site-settings-only _fields does not need the route table);
 *     - a route that matches no registered route (the fail-safe: a namespace the map missed is never a false 404).
 *   Settings and REST fields stay eager (their callbacks are not in the map), so the editor's preloaded settings are
 *   unchanged. The map is of WooCommerce MAPPED_WOO: on any other version nothing is deferred (and
 *   tests/wc-route-defer-test.sh fails until the map is checked again).
 *   Operator only, for an A/B on one build: x-pf-wc-defer: off (index.js passes it to PHP only with the spike token).
 *   A REST answer says what happened in X-PF-WC-Routes: deferred N/13 or registered N/13 (N: the map's callbacks
 *   found live; tests/wc-route-defer-e2e.sh fails unless all are), off, or unmapped <version>.
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
	private static $kept  = array();
	private static $state = '';
	public static $found  = array();

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

	public static function defer() {
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
		if ( ! self::$kept ) {
			return;
		}
		$kept       = self::$kept;
		self::$kept = array();
		$server     = rest_get_server();
		foreach ( $kept as $k ) {
			$n = max( 1, (int) $k['cb']['accepted_args'] );
			call_user_func_array( $k['cb']['function'], array_slice( array( $server ), 0, $n ) );
		}
		self::$state = 'registered ' . count( self::$found ) . '/' . count( self::DEFER );
	}

	public static function needs_routes( $server, $request ) {
		$route = (string) $request->get_route();
		if ( preg_match( '#^/(wc|jetpack)#', $route ) ) {
			return true;
		}
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
		foreach ( array_keys( $server->get_routes() ) as $r ) {
			if ( preg_match( '@^' . $r . '$@i', $route ) ) {
				return false;
			}
		}
		return true; // matches nothing registered: the fail-safe
	}

	public static function on_demand( $result, $server, $request ) {
		if ( self::$kept && self::needs_routes( $server, $request ) ) {
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
