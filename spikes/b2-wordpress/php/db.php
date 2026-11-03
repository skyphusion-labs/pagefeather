<?php
/**
 * wp-content/db.php: WordPress on D1.
 *
 * Loads the MySQL-on-SQLite driver from sqlite-database-integration and gives
 * it a D1_PDO instead of a local SQLite file.
 */

if ( ! defined( 'DB_ENGINE' ) ) {
	define( 'DB_ENGINE', 'sqlite' );
}
if ( ! defined( 'DB_PATH' ) ) {
	define( 'DB_PATH', ':memory:' );
}

$skyphusion_sqlite = WP_CONTENT_DIR . '/plugins/sqlite-database-integration';
require_once $skyphusion_sqlite . '/wp-includes/database/load.php';
require_once $skyphusion_sqlite . '/wp-includes/sqlite/class-wp-sqlite-db.php';
require_once $skyphusion_sqlite . '/wp-includes/sqlite/install-functions.php';
require_once __DIR__ . '/d1-pdo.php';

class D1_WPDB extends WP_SQLite_DB {
	public function db_connect( $allow_bail = true ) {
		if ( $this->dbh ) {
			return $this->ready;
		}
		$this->last_error = '';
		try {
			$dbh = new WP_MySQL_On_SQLite(
				sprintf( 'mysql-on-sqlite:path=:memory:;dbname=%s', str_replace( ';', ';;', $this->dbname ) ),
				null,
				null,
				array( 'sqlite_pdo' => new D1_PDO() )
			);
			$dbh->setAttribute( PDO::ATTR_STRINGIFY_FETCHES, true );
			$this->dbh = $dbh;
		} catch ( Throwable $e ) {
			$this->last_error = $e->getMessage();
		}
		if ( $this->last_error ) {
			return false;
		}
		$this->has_connected = true;
		$this->set_charset( $this->dbh );
		$this->ready = true;
		$this->set_sql_mode();
		return true;
	}
}

$GLOBALS['wpdb'] = new D1_WPDB( defined( 'DB_NAME' ) ? DB_NAME : 'wordpress' );
