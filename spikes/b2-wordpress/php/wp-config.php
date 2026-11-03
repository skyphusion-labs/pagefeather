<?php
/**
 * wp-config.php for the B2 spike. The database is D1 (see wp-content/db.php).
 * The keys below are fixed for a local spike only. A deploy must set its own.
 */
define( 'DB_NAME', 'wordpress' );
define( 'DB_USER', '' );
define( 'DB_PASSWORD', '' );
define( 'DB_HOST', '' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );

foreach ( array( 'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT' ) as $skyphusion_key ) {
	define( $skyphusion_key, 'local-spike-only-' . $skyphusion_key );
}

$table_prefix = 'wp_';

define( 'WP_HOME', getenv( 'SKYPHUSION_HOME' ) ?: 'http://localhost:8797' );
define( 'WP_SITEURL', WP_HOME );
define( 'WP_DEBUG', true );
define( 'WP_DEBUG_DISPLAY', true );
define( 'DISABLE_WP_CRON', true );
define( 'AUTOMATIC_UPDATER_DISABLED', true );
define( 'WP_HTTP_BLOCK_EXTERNAL', true );

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
