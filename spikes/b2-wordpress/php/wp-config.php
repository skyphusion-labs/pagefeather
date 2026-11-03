<?php
/**
 * wp-config.php for the B2 spike. The database is D1 (see wp-content/db.php).
 * A deploy sets its keys through the WP_SALT Worker secret (see index.js).
 */
define( 'DB_NAME', 'wordpress' );
define( 'DB_USER', '' );
define( 'DB_PASSWORD', '' );
define( 'DB_HOST', '' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );

// The Worker writes wp-runtime.php at boot: keys derived from its WP_SALT secret,
// and WP_HOME from the request origin. Without it (local only) fixed keys apply.
if ( file_exists( __DIR__ . '/wp-runtime.php' ) ) {
	require __DIR__ . '/wp-runtime.php';
}
foreach ( array( 'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT' ) as $skyphusion_key ) {
	if ( ! defined( $skyphusion_key ) ) {
		define( $skyphusion_key, 'local-spike-only-' . $skyphusion_key );
	}
}

$table_prefix = 'wp_';

if ( ! defined( 'WP_HOME' ) ) {
	define( 'WP_HOME', 'http://localhost:8797' );
}
if ( ! defined( 'WP_SITEURL' ) ) {
	define( 'WP_SITEURL', WP_HOME );
}
define( 'WP_DEBUG', true );
define( 'WP_DEBUG_DISPLAY', true );
define( 'DISABLE_WP_CRON', true );
define( 'AUTOMATIC_UPDATER_DISABLED', true );
define( 'WP_HTTP_BLOCK_EXTERNAL', true );

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
