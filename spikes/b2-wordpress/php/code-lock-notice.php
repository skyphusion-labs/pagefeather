<?php
/**
 * Plugin Name: Code lock notice
 * Description: Every site is code-locked (#458): the Plugins and Themes screens say how a plugin or theme is added.
 *
 * site-lock.mjs defines DISALLOW_FILE_MODS, DISALLOW_FILE_EDIT and SKYPHUSION_CODE_LOCK on every site
 * (not a demo site, which has its own notice). WordPress then hides "Add New" without a word. Core,
 * plugin and theme changes are code deploys (Conrad, 2026-11-13), so the notice says that, in one plain
 * sentence. It does not judge any plugin. Inert where the constant is not set.
 */

if ( ! defined( 'SKYPHUSION_CODE_LOCK' ) || true !== SKYPHUSION_CODE_LOCK ) {
	return;
}

function skyphusion_code_lock_notice_text( $screen_id ) {
	if ( 'plugins' === $screen_id ) {
		return 'You can activate and deactivate the plugins below here. To add, update or remove a plugin, add it to the site\'s build and deploy it.';
	}
	if ( 'themes' === $screen_id ) {
		return 'You can activate the themes below here. To add, update or remove a theme, add it to the site\'s build and deploy it.';
	}
	return '';
}

add_action(
	'admin_notices',
	function () {
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( ! $screen ) {
			return;
		}
		$text = skyphusion_code_lock_notice_text( $screen->id );
		if ( '' === $text ) {
			return;
		}
		echo '<div class="notice notice-info"><p>' . esc_html( $text ) . '</p></div>';
	}
);
