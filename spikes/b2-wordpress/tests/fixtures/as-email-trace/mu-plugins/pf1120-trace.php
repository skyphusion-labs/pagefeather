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
