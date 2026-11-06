<?php
/**
 * Plugin Name: C1 purge log
 * Description: One line per page cache purge request (spike measurement, issue #58).
 *
 * edge-cache.php fires skyphusion_edge_cache_purge_request for every hook that
 * asks for a purge. This writes one line to /tmp/c1-purge.log: the time, the
 * hook, the post type when the hook names a post, whether a purge was already
 * sent in this request, and the request path. /_stats.php?what=purge returns it.
 */
add_action(
	'skyphusion_edge_cache_purge_request',
	function ( $hook, $args, $already ) {
		$detail = '';
		if ( in_array( $hook, array( 'clean_post_cache', 'woocommerce_product_set_stock_status', 'woocommerce_variation_set_stock_status' ), true ) && isset( $args[0] ) ) {
			$detail = 'post_type=' . get_post_type( (int) $args[0] );
		} elseif ( 'updated_option' === $hook && isset( $args[0] ) ) {
			$detail = 'option=' . $args[0];
		} elseif ( 'clean_term_cache' === $hook && isset( $args[1] ) ) {
			$detail = 'taxonomy=' . ( is_string( $args[1] ) ? $args[1] : 'many' );
		}
		@file_put_contents(
			'/tmp/c1-purge.log',
			sprintf( "%.3f %s %s %s %s\n", microtime( true ), $hook, $detail ? $detail : '-', $already ? 'already' : 'sent', strtok( $_SERVER['REQUEST_URI'] ?? 'cli', ' ' ) ),
			FILE_APPEND | LOCK_EX
		);
	},
	10,
	3
);
