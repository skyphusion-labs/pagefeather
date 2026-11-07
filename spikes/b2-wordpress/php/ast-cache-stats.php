<?php
/**
 * Expose the per-request AST translation-cache counters (issue #173) as the
 * response header `x-ast-cache: hits=H misses=M`, so the live hit rate is
 * readable. The Worker forwards PHP response headers. REST (e.g. the Store API
 * checkout) is covered by rest_post_dispatch, which fires after the handler has
 * run every query; plain pages by send_headers (approximate: template queries
 * run after it). The cache is per-request (php-wasm clears userland state
 * between requests), so each response reports that request's own counts.
 */

function skyphusion_ast_cache_counts() {
	if ( ! class_exists( 'WP_MySQL_On_SQLite' ) ) {
		return null;
	}
	return 'hits=' . (int) WP_MySQL_On_SQLite::$ast_cache_hits . ' misses=' . (int) WP_MySQL_On_SQLite::$ast_cache_misses;
}

add_action(
	'send_headers',
	function () {
		$v = skyphusion_ast_cache_counts();
		if ( null !== $v && ! headers_sent() ) {
			header( 'x-ast-cache: ' . $v, true );
		}
	},
	0
);

add_filter(
	'rest_post_dispatch',
	function ( $response ) {
		$v = skyphusion_ast_cache_counts();
		if ( null !== $v && is_object( $response ) && method_exists( $response, 'header' ) ) {
			$response->header( 'x-ast-cache', $v );
		}
		return $response;
	},
	10,
	1
);
