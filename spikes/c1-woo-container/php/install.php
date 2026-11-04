<?php
/**
 * Spike C1: install WordPress and activate WooCommerce on an empty database.
 * Run by the entrypoint with php-cli, only when Litestream had no replica.
 * Needs ADMIN_PASSWORD (12+ characters) and PUBLIC_HOST.
 */
define( 'WP_INSTALLING', true );
$_SERVER['HTTP_HOST'] = getenv( 'PUBLIC_HOST' ) ?: 'localhost';
require __DIR__ . '/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
if ( is_blog_installed() ) {
	echo "already installed\n";
	exit( 0 );
}
$pw = (string) getenv( 'ADMIN_PASSWORD' );
if ( strlen( $pw ) < 12 ) {
	fwrite( STDERR, "ADMIN_PASSWORD missing or shorter than 12\n" );
	exit( 1 );
}
wp_install( 'WooCommerce in a Cloudflare Container', 'admin', 'admin@example.com', false, '', $pw );
wp_set_current_user( 1 );
$r = activate_plugin( 'woocommerce/woocommerce.php' );
echo is_wp_error( $r ) ? 'activate failed: ' . $r->get_error_message() . "\n" : "installed, WooCommerce active\n";
