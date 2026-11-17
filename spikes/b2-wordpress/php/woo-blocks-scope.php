<?php
/**
 * Plugin Name: WooCommerce blocks only where a screen can render them (#504)
 * Description: WooCommerce registers its block types and patterns eagerly on every request that renders, through
 * the filter woocommerce_should_register_blocks (WooCommerce 11.2, src/Blocks/Domain/BlockRegistrationContext.php).
 * Upstream already skips its own admin pages, AJAX, cron, the Store API and its REST namespaces. It leaves the core
 * admin screens registering, on purpose, because some of them are editors. Measured cost of that registration: 6 to
 * 9 MiB of WASM on every screen (#504 arm 2, `x-mem-off: wcblocks`). On b-dosql a site's PHP object has about 117 MiB
 * before its writes fail (#768).
 *
 * This skips it on the core admin screens that render NO block: an ALLOWLIST of screen files, never a guess. Every
 * other screen keeps upstream's answer: the post editor (post-new.php, post.php), the site editor, widgets, the
 * Customizer, the dashboard (a plugin's dashboard widget could render a block), list screens and any plugin screen.
 * It only ever turns upstream's "yes" into "no" on a listed screen; it never turns a "no" into a "yes". AJAX and REST
 * are left to upstream's own rules, and so is the front end. Tested in tests/woo-blocks-scope-test.php.
 *
 * Operator A/B on one build: `x-mem-off: wcscope` keeps upstream's answer everywhere. index.js passes x-mem-off to
 * PHP only with the spike token; if it ever reached PHP otherwise, the worst case is upstream's own default.
 */

if ( ! function_exists( 'skyphusion_woo_blocks_off_screens' ) ) {
	/** The core admin screens that render no block. A screen not listed keeps upstream's answer. */
	function skyphusion_woo_blocks_off_screens() {
		return array(
			// The profile and the user screens.
			'profile.php',
			'user-edit.php',
			'users.php',
			'user-new.php',
			// The settings pages.
			'options-general.php',
			'options-writing.php',
			'options-reading.php',
			'options-discussion.php',
			'options-media.php',
			'options-permalink.php',
			'options-privacy.php',
			// Tools.
			'tools.php',
			'export-personal-data.php',
			'erase-personal-data.php',
		);
	}
}

if ( ! function_exists( 'skyphusion_woo_blocks_scope_off' ) ) {
	/** True when the operator switch x-mem-off names wcscope (an exact token in the comma list). */
	function skyphusion_woo_blocks_scope_off() {
		$h = isset( $_SERVER['HTTP_X_MEM_OFF'] ) ? strtolower( (string) $_SERVER['HTTP_X_MEM_OFF'] ) : '';
		return in_array( 'wcscope', array_map( 'trim', explode( ',', $h ) ), true );
	}
}

if ( ! function_exists( 'skyphusion_woo_blocks_scope' ) ) {
	/**
	 * @param bool $register Upstream's answer.
	 * @return bool
	 */
	function skyphusion_woo_blocks_scope( $register ) {
		if ( ! is_admin() || wp_doing_ajax() || skyphusion_woo_blocks_scope_off() ) {
			return $register;
		}
		global $pagenow;
		return is_string( $pagenow ) && in_array( $pagenow, skyphusion_woo_blocks_off_screens(), true ) ? false : $register;
	}
}
add_filter( 'woocommerce_should_register_blocks', 'skyphusion_woo_blocks_scope', 10 );
