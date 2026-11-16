<?php
/**
 * #504: php/woo-blocks-scope.php, with WordPress stubbed. WooCommerce registers its block types and patterns eagerly
 * on every request that renders, through the filter woocommerce_should_register_blocks (BlockRegistrationContext).
 * It already skips its own admin pages, and leaves core admin screens registering. This mu-plugin also skips the core
 * admin screens that render no block: an ALLOWLIST, never a guess. Measured cost of that registration: 6 to 9 MiB of
 * WASM on every screen (#504 arm 2).
 *   1. A listed screen (profile.php, the user screens, the settings pages, tools): no registration.
 *   2. Every other admin screen keeps upstream's answer: post-new, post.php, the site editor, widgets, the dashboard.
 *   3. It never turns upstream's "no" into "yes".
 *   4. AJAX and REST are left to upstream's own rules; so is the front end.
 * Run: php spikes/b2-wordpress/tests/woo-blocks-scope-test.php
 */
$GLOBALS['filters'] = array();
$GLOBALS['admin']   = true;
$GLOBALS['ajax']    = false;
function add_filter( $h, $cb, $prio = 10 ) { $GLOBALS['filters'][ $h ] = array( $cb, $prio ); return true; }
function is_admin() { return $GLOBALS['admin']; }
function wp_doing_ajax() { return $GLOBALS['ajax']; }
require __DIR__ . '/../php/woo-blocks-scope.php';

$fails = 0;
function ok( $label, $cond ) { global $fails; echo ( $cond ? 'PASS ' : 'FAIL ' ) . $label . "\n"; if ( ! $cond ) { $fails++; } }
function decide( $pagenow, $upstream = true, $admin = true, $ajax = false ) {
	$GLOBALS['pagenow'] = $pagenow; $GLOBALS['admin'] = $admin; $GLOBALS['ajax'] = $ajax;
	$f = $GLOBALS['filters']['woocommerce_should_register_blocks'][0] ?? null;
	return $f ? call_user_func( $f, $upstream ) : $upstream;
}

ok( 'hooks woocommerce_should_register_blocks', isset( $GLOBALS['filters']['woocommerce_should_register_blocks'] ) );
foreach ( array( 'profile.php', 'user-edit.php', 'users.php', 'user-new.php', 'options-general.php', 'options-writing.php', 'options-reading.php', 'options-discussion.php', 'options-media.php', 'options-permalink.php', 'options-privacy.php', 'tools.php', 'export-personal-data.php', 'erase-personal-data.php' ) as $s ) {
	ok( "$s: no block registration", false === decide( $s ) );
}
foreach ( array( 'post-new.php', 'post.php', 'site-editor.php', 'widgets.php', 'customize.php', 'index.php', 'edit.php', 'admin.php', 'nav-menus.php', 'upload.php' ) as $s ) {
	ok( "$s: upstream's answer kept (true)", true === decide( $s ) );
}
ok( 'upstream says no: still no (profile.php)', false === decide( 'profile.php', false ) );
ok( 'upstream says no: still no (post.php)', false === decide( 'post.php', false ) );
ok( 'AJAX from profile.php: left to upstream', true === decide( 'profile.php', true, true, true ) );
ok( 'the front end: left to upstream', true === decide( 'profile.php', true, false ) );
ok( 'an unknown screen name: kept (an allowlist)', true === decide( 'my-plugin-screen.php' ) );
ok( 'no pagenow at all: kept', true === decide( null ) );
// The operator A/B switch: x-mem-off carrying wcscope (index.js passes x-mem-off only with the spike token).
$_SERVER['HTTP_X_MEM_OFF'] = 'preload, WCSCOPE';
ok( 'x-mem-off: wcscope keeps upstream on a listed screen', true === decide( 'profile.php' ) );
$_SERVER['HTTP_X_MEM_OFF'] = 'wcscopex,wcblocks';
ok( 'x-mem-off without the exact wcscope token: still off', false === decide( 'profile.php' ) );
unset( $_SERVER['HTTP_X_MEM_OFF'] );
echo $fails . " failing\n";
exit( $fails ? 1 : 0 );
