<?php
/*
 * Take a WordPress database that is already SQLite (made by the
 * sqlite-database-integration driver, for example a c1 container store or its
 * Litestream replica restored to a file) as the import source, in place of a
 * MySQL dump.
 *
 *   php sqlite-source.php <driver-dir> <in.sqlite> <out.sqlite> [dbname]
 *
 * It writes a consistent copy of <in> to <out> (VACUUM INTO, read from a
 * read-only connection, so <in> is never written) and prints the same JSON
 * report as dump-to-sqlite.php: the prefix, the rows of each table (read back
 * through the driver), the tables without the prefix and the site facts. The
 * report also has "source": "sqlite" and "driver_version", the version the
 * file was made with.
 *
 * Refused, with exit 1 and a message, before any copy:
 * - a file that SQLite does not call ok (PRAGMA integrity_check);
 * - a WAL file beside <in> that is not empty: the copy would miss what is only
 *   in the WAL, so checkpoint or restore the file first;
 * - a file the driver did not make (no _wp_sqlite_global_variables with
 *   _wp_sqlite_driver_version);
 * - a file made by a newer driver than <driver-dir>. An older one is fine:
 *   the driver configures an older file for its own version at first use
 *   (WP_SQLite_Configurator::ensure_database_configured);
 * - a table prefix that is not wp_. The runtime reads wp_options by name, and
 *   the driver cannot rename a table (ALTER TABLE ... RENAME TO changes
 *   nothing, 3.1.3, measured 2026-11-06), so a site with another prefix comes
 *   in through a MySQL dump instead (DUMP=, which renames as it reads);
 * - a multisite network (a wp_blogs table).
 */

const NEW_PREFIX = 'wp_';

if ( $argc < 4 ) {
	fwrite( STDERR, "usage: php sqlite-source.php <driver-dir> <in.sqlite> <out.sqlite> [dbname]\n" );
	exit( 2 );
}
[ , $driver_dir, $in, $out ] = $argv;
$dbname = $argv[4] ?? 'wordpress';

function fail( string $message ): void {
	fwrite( STDERR, $message . "\n" );
	exit( 1 );
}
function q( string $s ): string {
	return "'" . str_replace( "'", "''", $s ) . "'";
}

if ( file_exists( $out ) ) {
	fwrite( STDERR, "$out exists; remove it first\n" );
	exit( 2 );
}
if ( ! is_readable( $in ) ) {
	fwrite( STDERR, "cannot read $in\n" );
	exit( 2 );
}
if ( is_file( $in . '-wal' ) && filesize( $in . '-wal' ) > 0 ) {
	fail( "$in has a WAL file that is not empty ($in-wal): checkpoint it, or restore the database to a file first" );
}

require_once rtrim( $driver_dir, '/' ) . '/packages/mysql-on-sqlite/src/load.php';

// Plain SQLite, read only: integrity, the driver's own version, the tables.
$raw = new PDO( 'sqlite:file:' . rawurlencode( realpath( $in ) ) . '?mode=ro', null, null, array( PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION ) );
$ok  = $raw->query( 'PRAGMA integrity_check' )->fetchAll( PDO::FETCH_COLUMN );
if ( array( 'ok' ) !== $ok ) {
	fail( "$in is not ok: " . implode( '; ', array_slice( $ok, 0, 5 ) ) );
}
$names = $raw->query( "SELECT name FROM sqlite_master WHERE type = 'table'" )->fetchAll( PDO::FETCH_COLUMN );
$tables = array_fill_keys( $names, true );
if ( ! isset( $tables['_wp_sqlite_global_variables'] ) ) {
	fail( "$in was not made by the SQLite driver (no _wp_sqlite_global_variables): import it through a MySQL dump (DUMP=)" );
}
$made_with = $raw->query( "SELECT value FROM _wp_sqlite_global_variables WHERE name = '_wp_sqlite_driver_version'" )->fetchColumn();
if ( ! is_string( $made_with ) || '' === $made_with ) {
	fail( "$in has no _wp_sqlite_driver_version: import it through a MySQL dump (DUMP=)" );
}
if ( version_compare( $made_with, SQLITE_DRIVER_VERSION ) > 0 ) {
	fail( "$in was made by driver $made_with, newer than the pinned driver " . SQLITE_DRIVER_VERSION . " (SQLITE_DI_REF): pin the newer driver, or import through a MySQL dump" );
}
$prefixes = array();
foreach ( $names as $name ) {
	if ( str_ends_with( $name, 'options' ) ) {
		$p = substr( $name, 0, -strlen( 'options' ) );
		if ( '' !== $p && isset( $tables[ $p . 'posts' ], $tables[ $p . 'usermeta' ] ) ) {
			$prefixes[] = $p;
		}
	}
}
if ( 1 !== count( $prefixes ) ) {
	fail( sprintf( 'cannot find one WordPress table prefix in %s (found %d: %s)', $in, count( $prefixes ), implode( ', ', $prefixes ) ) );
}
$old = $prefixes[0];
if ( isset( $tables[ $old . 'blogs' ] ) ) {
	fail( "$in is a multisite network ({$old}blogs); import supports one site only" );
}
if ( NEW_PREFIX !== $old ) {
	fail( "$in has the table prefix $old, not wp_. The driver cannot rename a table, so import this site through a MySQL dump (DUMP=), which renames as it reads" );
}

// The copy. VACUUM INTO writes a new, consistent file and leaves the source as it is.
$raw->exec( 'VACUUM INTO ' . q( $out ) );
$raw = null;

// Read back through the driver, as dump-to-sqlite.php does.
$db = new WP_MySQL_On_SQLite(
	sprintf( 'mysql-on-sqlite:path=%s;dbname=%s', $out, str_replace( ';', ';;', $dbname ) )
);
$rows  = array();
$other = array();
foreach ( $db->query( 'SHOW TABLES' )->fetchAll( PDO::FETCH_NUM ) as [ $table ] ) {
	$rows[ $table ] = (int) $db->query( 'SELECT COUNT(*) FROM `' . str_replace( '`', '``', $table ) . '`' )->fetchColumn();
	if ( ! str_starts_with( $table, NEW_PREFIX ) ) {
		$other[] = $table;
	}
}
$site = array();
foreach ( array( 'home', 'siteurl', 'template', 'stylesheet', 'active_plugins', 'db_version' ) as $name ) {
	$v = $db->query( "SELECT option_value FROM `wp_options` WHERE option_name = '" . $name . "'" )->fetchColumn();
	if ( 'active_plugins' === $name && is_string( $v ) ) {
		$list = @unserialize( $v, array( 'allowed_classes' => false ) );
		$v    = is_array( $list ) ? array_values( $list ) : $v;
	}
	$site[ $name ] = false === $v ? null : $v;
}
echo json_encode(
	array(
		'source'         => 'sqlite',
		'driver_version' => $made_with,
		'prefix'         => $old,
		'renamed'        => false,
		'keys_changed'   => array( 'options' => 0, 'usermeta' => 0 ),
		'statements'     => 0,
		'rows'           => $rows,
		'without_prefix' => $other,
		'site'           => $site,
	),
	JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
), "\n";
