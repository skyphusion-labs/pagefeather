<?php
/**
 * Plugin Name: #1120 diagnostic fixture: where a queued order email goes in a cron leg (THROWAWAY BUILDS ONLY)
 * Deployed only with IMPORT_CONTENT=<this fixture dir> IMPORT_MU_PLUGINS=pf1120-trace.php on a throwaway; never a site
 * build. One "mem-mark" line per step (Workers Logs, m mem-mark, k "pf1120 ..."): whether the async mail override is on
 * and which file wp_mail comes from, WooCommerce's allow filter, the mailer, the new-order email's enabled and
 * recipient checks, each wp_mail call, and wp_mail_failed with its message, every address scrubbed.
 */
function pf1120_mark( $k ) {
	if ( function_exists( 'post_message_to_js' ) ) {
		$k = preg_replace( '/[^\s@<>"\'(),;:]+@[^\s@<>"\'(),;:]+/', '[address]', (string) $k );
		post_message_to_js( json_encode( array( 'memMark' => 'pf1120 ' . substr( $k, 0, 180 ) ) ) );
	}
}
add_action(
	'action_scheduler_begin_execute',
	static function ( $id ) {
		$f = function_exists( 'wp_mail' ) ? ( new ReflectionFunction( 'wp_mail' ) )->getFileName() : 'none';
		$GLOBALS['pf1120_t0'] = microtime( true );
		pf1120_mark( 'begin ' . (int) $id . ' async=' . ( defined( 'SKYPHUSION_ASYNC_EMAIL' ) && SKYPHUSION_ASYNC_EMAIL ? 1 : 0 ) . ' wp_mail=' . basename( dirname( $f ) ) . '/' . basename( $f ) . ' p2js=' . ( function_exists( 'post_message_to_js' ) ? 1 : 0 ) );
	},
	1
);
// #1143: WooCommerce's DeferredEmailQueue restores each queued object by id (wc_get_order and the like) and returns
// SILENTLY when one cannot be restored. Per queued-email action: each reference (type and id only), what its fetch
// returns, the HPOS state, the order data store, and whether the order's row is in the orders table and in posts.
add_action(
	'action_scheduler_begin_execute',
	static function ( $id ) {
		if ( ! class_exists( 'ActionScheduler' ) ) {
			return;
		}
		$a = ActionScheduler::store()->fetch_action( $id );
		if ( ! $a || 'woocommerce_send_queued_transactional_email' !== $a->get_hook() ) {
			return;
		}
		$args = (array) $a->get_args();
		pf1120_mark( 'args ' . (int) $id . ' n=' . count( $args ) . ' filter=' . ( isset( $args[0] ) && is_string( $args[0] ) ? substr( $args[0], 0, 80 ) : gettype( isset( $args[0] ) ? $args[0] : null ) ) . ' second=' . gettype( isset( $args[1] ) ? $args[1] : null ) );
		$hpos = class_exists( '\\Automattic\\WooCommerce\\Utilities\\OrderUtil' ) ? ( \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled() ? 1 : 0 ) : -1;
		$walk = static function ( $v ) use ( &$walk, $id, $hpos ) {
			if ( ! is_array( $v ) ) {
				return;
			}
			if ( isset( $v['__woocommerce_deferred_email_object'] ) && is_array( $v['__woocommerce_deferred_email_object'] ) ) {
				$r   = $v['__woocommerce_deferred_email_object'];
				$t   = isset( $r['type'] ) ? (string) $r['type'] : '?';
				$oid = isset( $r['id'] ) ? $r['id'] : '?';
				$got = 'n/a';
				$rows = '';
				if ( 'order' === $t && function_exists( 'wc_get_order' ) ) {
					$o   = wc_get_order( $oid );
					$got = is_object( $o ) ? get_class( $o ) : var_export( $o, true );
					global $wpdb;
					$in_orders = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->prefix}wc_orders WHERE id = %d", (int) $oid ) );
					$in_posts  = (int) $wpdb->get_var( $wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->posts} WHERE ID = %d", (int) $oid ) );
					$rows = ' in_wc_orders=' . $in_orders . ' in_posts=' . $in_posts . ' store=' . ( class_exists( 'WC_Data_Store' ) ? WC_Data_Store::load( 'order' )->get_current_class_name() : '?' );
				}
				pf1120_mark( 'ref ' . (int) $id . ' type=' . $t . ' id=' . $oid . ' fetched=' . $got . ' hpos=' . $hpos . $rows );
				return;
			}
			foreach ( $v as $x ) {
				$walk( $x );
			}
		};
		$walk( $args );
	},
	2
);
add_action(
	'action_scheduler_after_execute',
	static function ( $id ) {
		$ms = isset( $GLOBALS['pf1120_t0'] ) ? (int) round( ( microtime( true ) - $GLOBALS['pf1120_t0'] ) * 1000 ) : -1;
		pf1120_mark( 'after ' . (int) $id . ' ms=' . $ms . ' queries=' . ( isset( $GLOBALS['wpdb'] ) ? (int) $GLOBALS['wpdb']->num_queries : -1 ) );
	},
	PHP_INT_MAX
);
add_filter( 'woocommerce_allow_send_queued_transactional_email', static function ( $ok, $filter ) { pf1120_mark( 'allow ' . ( $ok ? 1 : 0 ) . ' ' . $filter ); return $ok; }, PHP_INT_MAX, 2 );
add_filter( 'wp_mail', static function ( $a ) { pf1120_mark( 'wp_mail called' ); return $a; }, 1 );
add_action( 'wp_mail_failed', static function ( $e ) { pf1120_mark( 'wp_mail_failed ' . ( is_wp_error( $e ) ? $e->get_error_message() : '' ) ); } );
add_action( 'woocommerce_email', static function () { pf1120_mark( 'mailer built' ); } );
add_filter( 'woocommerce_email_enabled_new_order', static function ( $on ) { pf1120_mark( 'new_order enabled=' . ( $on ? 1 : 0 ) ); return $on; }, PHP_INT_MAX );
add_filter( 'woocommerce_email_recipient_new_order', static function ( $r ) { pf1120_mark( 'new_order recipient set=' . ( $r ? 1 : 0 ) ); return $r; }, PHP_INT_MAX );
add_filter( 'woocommerce_email_enabled_customer_processing_order', static function ( $on ) { pf1120_mark( 'customer_processing enabled=' . ( $on ? 1 : 0 ) ); return $on; }, PHP_INT_MAX );
