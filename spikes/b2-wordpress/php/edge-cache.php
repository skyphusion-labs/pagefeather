<?php
/**
 * Plugin Name: Edge Cache
 * Description: Purge the Worker's page cache (Workers Cache) when content changes.
 *
 * The Worker marks logged-out pages cacheable with Cache-Tag: wp-pages. Then
 * Cloudflare serves them without running the Worker or PHP. When WordPress
 * changes content, this plugin asks the Worker to purge that tag once, after
 * the request. The cache TTL limits staleness if a purge fails.
 */

if ( ! function_exists( 'post_message_to_js' ) ) {
	return;
}

function skyphusion_edge_cache_purge() {
	static $sent = false;
	if ( ! $sent ) {
		$sent = true;
		post_message_to_js( json_encode( array( 'cache' => 'purge' ) ) );
	}
}

foreach ( array( 'clean_post_cache', 'clean_comment_cache', 'clean_term_cache', 'switch_theme', 'customize_save_after', 'wp_update_nav_menu', 'activated_plugin', 'deactivated_plugin' ) as $skyphusion_hook ) {
	add_action( $skyphusion_hook, 'skyphusion_edge_cache_purge' );
}

// Site options (title, permalinks, reading settings, widgets) change pages too.
// Transients and cron are options as well; they change on their own, so skip them.
add_action(
	'updated_option',
	function ( $name ) {
		if ( ! preg_match( '/^(_transient_|_site_transient_|cron$|rewrite_rules$|recently_activated$|_edit_lock)/', $name ) ) {
			skyphusion_edge_cache_purge();
		}
	}
);
