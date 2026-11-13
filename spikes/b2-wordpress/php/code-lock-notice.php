<?php
/**
 * Plugin Name: Code lock notice
 * Description: On a one-click site (CODE_LOCK=on, issue #406), the Plugins and Themes screens say why there is no way to add one.
 *
 * site-lock.mjs defines DISALLOW_FILE_MODS, DISALLOW_FILE_EDIT and SKYPHUSION_CODE_LOCK on such a site.
 * WordPress then hides "Add New" without a word. A plugin or theme installed from wp-admin
 * would not persist on this site (docs/plugins.md), so it is not offered. This notice says so.
 * Inert on every other site: it returns before it adds anything.
 */

if ( ! defined( 'SKYPHUSION_CODE_LOCK' ) || true !== SKYPHUSION_CODE_LOCK ) {
	return;
}

function skyphusion_code_lock_notice_text( $screen_id ) {
	if ( 'plugins' === $screen_id ) {
		return 'This site comes with the plugins listed below. You can activate and deactivate them here. You cannot add new plugins to this site yet.';
	}
	if ( 'themes' === $screen_id ) {
		return 'This site comes with the themes shown below. You can activate them here. You cannot add new themes to this site yet.';
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
