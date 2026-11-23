<?php
/**
 * Plugin Name: Pagefeather conformance throwaway marker (#759)
 * Description: Marks a THROWAWAY site built for the upstream test suites. tests/conformance/runner.py
 * refuses every site without this marker, because those suites delete all posts, pages and orders.
 * prepare-content.sh ships it; never put it on a real site.
 *
 * #1401: it also carries the one reset the seed needs that core REST cannot do. Gutenberg's style revision specs
 * assume a fresh wp-env, where no user global-styles post has a revision. Core REST has no DELETE for a
 * wp_global_styles post or its revisions, so earlier runs' revisions stayed (44 on cf759hw). POST
 * pf-conformance/v1/reset-global-styles deletes every wp_global_styles post with its revisions; WordPress makes the
 * post again, empty, on the next request that asks for it.
 *
 * The gate, all three required (anything less is refused, 401/403, and nothing is deleted):
 *   1. THE THROWAWAY: only this marker registers the route, and deploy/conformance.sh lets the marker onto a site only
 *      with CONFORMANCE=on, THROWAWAY=1 and a named site that is not in deploy/live-sites/ or deploy/wfp/live-sites/.
 *   2. THE SPIKE TOKEN: the request carries x-pf-conformance-reset: 1, and the Worker (index.js, handleInner, through
 *      stripOperatorHeaders in operator-headers.mjs) removes that header, under every spelling PHP maps to the same
 *      key, before PHP runs unless x-spike-token matches the site's SPIKE_TOKEN secret. PHP never sees the token; it
 *      sees the header only when the Worker has checked it.
 *   3. THE USER: a logged-in user who can edit theme options.
 * Tested in tests/conformance/throwaway-php-test.sh (and the Worker's strip in spikes/b2-wordpress/tests).
 */
function pf_conformance_reset_allowed() {
	return isset( $_SERVER['HTTP_X_PF_CONFORMANCE_RESET'] ) && '1' === $_SERVER['HTTP_X_PF_CONFORMANCE_RESET']
		&& current_user_can( 'edit_theme_options' );
}

function pf_conformance_global_styles_ids() {
	return get_posts(
		array(
			'post_type'        => 'wp_global_styles',
			'post_status'      => array_keys( get_post_stati() ),
			'numberposts'      => -1,
			'fields'           => 'ids',
			'no_found_rows'    => true,
			'suppress_filters' => true,
		)
	);
}

function pf_conformance_reset_global_styles() {
	$ids       = pf_conformance_global_styles_ids();
	$posts     = 0;
	$revisions = 0;
	foreach ( $ids as $id ) {
		$revisions += count( wp_get_post_revisions( $id, array( 'fields' => 'ids' ) ) );
		// wp_delete_post deletes the post's revisions with it.
		if ( wp_delete_post( $id, true ) ) {
			++$posts;
		}
	}
	if ( class_exists( 'WP_Theme_JSON_Resolver' ) ) {
		WP_Theme_JSON_Resolver::clean_cached_data();
	}
	$left           = pf_conformance_global_styles_ids();
	$left_revisions = empty( $ids ) ? 0 : count(
		get_posts(
			array(
				'post_type'        => 'revision',
				'post_status'      => 'any',
				'post_parent__in'  => $ids,
				'numberposts'      => -1,
				'fields'           => 'ids',
				'no_found_rows'    => true,
				'suppress_filters' => true,
			)
		)
	);
	return array(
		'reset'          => true,
		'posts'          => $posts,
		'revisions'      => $revisions,
		'left_posts'     => count( $left ),
		'left_revisions' => $left_revisions,
	);
}

add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'pf-conformance/v1',
			'/throwaway',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'callback'            => function () {
					return array(
						'throwaway' => true,
						'host'      => wp_parse_url( home_url(), PHP_URL_HOST ),
					);
				},
			)
		);
		register_rest_route(
			'pf-conformance/v1',
			'/reset-global-styles',
			array(
				'methods'             => 'POST',
				'permission_callback' => 'pf_conformance_reset_allowed',
				'callback'            => 'pf_conformance_reset_global_styles',
			)
		);
	}
);
