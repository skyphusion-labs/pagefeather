<?php
// php deploy/import/tests/m1-install.php <wordpress dir> install|boot   (#479 M1)
// The reference install for the dialect check: a plain WordPress on MySQL 8 (the CI service
// container's throwaway credentials, nothing else), WooCommerce activated. "boot" loads WordPress
// once more as an admin request, so installers that run on init or admin_init (WooCommerce's
// version check, Action Scheduler's tables) have run. Exit non-zero on any failure.
[ , $dir, $mode ] = $argv + array( null, null, null );
if ( ! $dir || ! in_array( $mode, array( 'install', 'boot' ), true ) ) {
	fwrite( STDERR, "usage: m1-install.php <wordpress dir> install|boot\n" );
	exit( 2 );
}
$dir = rtrim( $dir, '/' );
if ( ! file_exists( "$dir/wp-config.php" ) ) {
	$cfg = file_get_contents( "$dir/wp-config-sample.php" );
	$cfg = str_replace(
		array( "'database_name_here'", "'username_here'", "'password_here'", "'localhost'" ),
		array( "'wordpress'", "'root'", "'m1-throwaway'", "'127.0.0.1'" ),
		$cfg
	);
	file_put_contents( "$dir/wp-config.php", $cfg );
}
$_SERVER['HTTP_HOST']   = 'm1.example';
$_SERVER['REQUEST_URI'] = '/wp-admin/';
$_SERVER['SERVER_NAME'] = 'm1.example';
if ( 'install' === $mode ) {
	define( 'WP_INSTALLING', true );
	require "$dir/wp-load.php";
	require_once "$dir/wp-admin/includes/upgrade.php";
	$r = wp_install( 'M1 reference', 'admin', 'admin@example.com', false, '', wp_generate_password( 24 ) );
	if ( empty( $r['user_id'] ) ) {
		fwrite( STDERR, "wp_install failed\n" );
		exit( 1 );
	}
	require_once "$dir/wp-admin/includes/plugin.php";
	$a = activate_plugin( 'woocommerce/woocommerce.php' );
	if ( is_wp_error( $a ) ) {
		fwrite( STDERR, 'activate_plugin: ' . $a->get_error_message() . "\n" );
		exit( 1 );
	}
	echo "installed, WooCommerce activated\n";
	exit( 0 );
}
define( 'WP_ADMIN', true );
require "$dir/wp-load.php";
wp_set_current_user( 1 );
do_action( 'admin_init' );
if ( class_exists( 'WC_Install' ) ) {
	WC_Install::check_version();
	WC_Install::create_tables();
}
global $wpdb;
echo 'tables: ' . count( $wpdb->get_col( 'SHOW TABLES' ) ) . "\n";
