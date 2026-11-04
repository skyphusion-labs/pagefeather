<?php
/**
 * wp-config.php for spike C1: WordPress + WooCommerce in a Container.
 * The database is a SQLite file on the container disk (/data), replicated to
 * R2 by Litestream. The Worker passes WP_SALT and switches as environment vars.
 */
define( 'DB_NAME', 'wordpress' );
define( 'DB_USER', '' );
define( 'DB_PASSWORD', '' );
define( 'DB_HOST', '' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );
define( 'DB_DIR', '/data/' );
define( 'DB_FILE', 'wordpress.sqlite' );

foreach ( array( 'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT' ) as $skyphusion_key ) {
	define( $skyphusion_key, hash( 'sha256', (string) getenv( 'WP_SALT' ) . ':' . $skyphusion_key ) );
}
$table_prefix = 'wp_';

// Requests come through the Worker over HTTPS; the host is the public one.
$_SERVER['HTTPS'] = 'on';
$skyphusion_host  = getenv( 'PUBLIC_HOST' ) ?: ( $_SERVER['HTTP_HOST'] ?? 'localhost' );
define( 'WP_HOME', 'https://' . $skyphusion_host );
define( 'WP_SITEURL', WP_HOME );

define( 'R2_UPLOADS', (bool) getenv( 'R2_UPLOADS' ) );
define( 'CF_IMAGES', (bool) getenv( 'CF_IMAGES' ) );
define( 'WP_DEBUG', false );
define( 'DISABLE_WP_CRON', true );
define( 'AUTOMATIC_UPDATER_DISABLED', true );
define( 'WP_MEMORY_LIMIT', '256M' );
// WooCommerce writes log files under uploads/wc-logs. Uploads live in R2, so
// every log line was an R2 read and write: about 30 calls and 15 s of each
// checkout (measured 2026-11-04). Logs go to local disk instead.
define( 'WC_LOG_DIR', '/tmp/wc-logs/' );

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
