<?php
/**
 * Spike C1: install WordPress and activate WooCommerce on an empty database.
 * Run by the entrypoint with php-cli, only when Litestream had no replica.
 * Needs ADMIN_PASSWORD (12+ characters) and PUBLIC_HOST. ADMIN_EMAIL (issue #104,
 * default MAIL_FROM, else admin@example.com) is the admin user's and the site's
 * address; with MAIL_FROM, WooCommerce sends from it (woocommerce_email_from_address),
 * so its mails carry no From that the Worker would have to turn into a Reply-To.
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
$email = (string) getenv( 'ADMIN_EMAIL' );
$email = filter_var( $email, FILTER_VALIDATE_EMAIL ) ? $email : 'admin@example.com';
wp_install( 'WooCommerce in a Cloudflare Container', 'admin', $email, false, '', $pw );
wp_set_current_user( 1 );
$r = activate_plugin( 'woocommerce/woocommerce.php' );
echo is_wp_error( $r ) ? 'activate failed: ' . $r->get_error_message() . "\n" : "installed, WooCommerce active\n";
$from = (string) getenv( 'MAIL_FROM' );
if ( filter_var( $from, FILTER_VALIDATE_EMAIL ) ) {
	update_option( 'woocommerce_email_from_address', $from );
	update_option( 'woocommerce_email_from_name', get_bloginfo( 'name' ) );
	echo "WooCommerce mail from: the MAIL_FROM address\n";
}
