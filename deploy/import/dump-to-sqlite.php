<?php
/*
 * Load a MySQL dump of a WordPress site into a new SQLite file, through the
 * MySQL-on-SQLite driver that WordPress uses at runtime
 * (sqlite-database-integration).
 *
 *   php dump-to-sqlite.php <driver-dir> <dump.sql> <out.sqlite> [dbname]
 *
 * <driver-dir> is a checkout of WordPress/sqlite-database-integration at the
 * ref the build uses (SQLITE_DI_REF in spikes/b2-wordpress/build.sh). The
 * driver writes its own _wp_sqlite_* tables, which the runtime reads, so the
 * ref must match. dbname is DB_NAME of the runtime (default "wordpress").
 *
 * The dump is the output of mysqldump or "wp db export", made with
 * --hex-blob. Without it, mysqldump writes binary values as _binary '...', and
 * the driver (3.1.3) does not read a character set introducer. The script
 * stops on such a statement and says so.
 *
 * Table prefix. The runtime reads wp_options by name, so the tables must have
 * the prefix wp_. The script finds the prefix of the dump (the one table set
 * with options, posts and usermeta) and, if it is not wp_, changes it while it
 * reads: in the table name of DROP TABLE, CREATE TABLE, INSERT INTO and
 * REPLACE INTO, and in REFERENCES of CREATE TABLE. Then it changes the keys
 * that WordPress names with the prefix: the option <prefix>user_roles and
 * the user meta keys that start with the prefix. A table without the prefix
 * keeps its name; the report lists it. The driver cannot rename a table after
 * it is made: ALTER TABLE ... RENAME TO returns no error and changes nothing
 * (3.1.3, measured 2026-11-06), and RENAME TABLE is not supported. A multisite
 * dump (a <prefix>blogs table) is refused.
 *
 * Statements. One statement ends with ";" at the end of a line, and the lexer
 * confirms that the ";" is not in a string. These lines are skipped: comments,
 * blank lines, conditional comments ("/*!" and "/*M!", the session settings of
 * mysqldump), and LOCK TABLES and UNLOCK TABLES. sql_mode is
 * NO_AUTO_VALUE_ON_ZERO, as mysqldump sets it, so a row with id 0 keeps id 0.
 *
 * Output on stdout: one JSON object. It has the prefix of the dump, the
 * statement count, the rows of each table (read back through the driver) and
 * the site facts: home, siteurl, template, stylesheet, active_plugins and
 * db_version. Errors go to stderr, with the statement number and its first
 * 200 bytes, and the exit status is 1.
 */

const NEW_PREFIX = 'wp_';

if ( $argc < 4 ) {
	fwrite( STDERR, "usage: php dump-to-sqlite.php <driver-dir> <dump.sql> <out.sqlite> [dbname]\n" );
	exit( 2 );
}
[ , $driver_dir, $dump, $out ] = $argv;
$dbname = $argv[4] ?? 'wordpress';

require_once rtrim( $driver_dir, '/' ) . '/packages/mysql-on-sqlite/src/load.php';

// A MySQL string literal. The driver has no prepared statements.
function q( string $s ): string {
	return "'" . str_replace( array( '\\', "'", "\0" ), array( '\\\\', "\\'", '\\0' ), $s ) . "'";
}

function fail( string $message ): void {
	fwrite( STDERR, $message . "\n" );
	exit( 1 );
}

if ( file_exists( $out ) ) {
	fwrite( STDERR, "$out exists; remove it first\n" );
	exit( 2 );
}
if ( ! is_readable( $dump ) ) {
	fwrite( STDERR, "cannot read $dump\n" );
	exit( 2 );
}

// Pass 1: the table names of CREATE TABLE, to find the prefix.
$tables = array();
$in     = fopen( $dump, 'rb' );
while ( false !== ( $line = fgets( $in ) ) ) {
	if ( preg_match( '/^CREATE TABLE (?:IF NOT EXISTS )?`([^`]+)`/', $line, $m ) ) {
		$tables[ $m[1] ] = true;
	}
}
fclose( $in );
$prefixes = array();
foreach ( array_keys( $tables ) as $name ) {
	if ( str_ends_with( $name, 'options' ) ) {
		$p = substr( $name, 0, -strlen( 'options' ) );
		if ( isset( $tables[ $p . 'posts' ], $tables[ $p . 'usermeta' ] ) ) {
			$prefixes[] = $p;
		}
	}
}
if ( 1 !== count( $prefixes ) ) {
	fail( sprintf( 'cannot find one WordPress table prefix in the dump (found %d: %s)', count( $prefixes ), implode( ', ', $prefixes ) ) );
}
$old = $prefixes[0];
if ( isset( $tables[ $old . 'blogs' ] ) ) {
	fail( "the dump is a multisite network ({$old}blogs); import supports one site only" );
}

// The table name with the new prefix.
function rename_table( string $name ): string {
	global $old;
	return str_starts_with( $name, $old ) ? NEW_PREFIX . substr( $name, strlen( $old ) ) : $name;
}
function rename_statement( string $sql ): string {
	global $old;
	if ( NEW_PREFIX === $old ) {
		return $sql;
	}
	$sql = preg_replace_callback(
		'/^(DROP TABLE IF EXISTS |DROP TABLE |CREATE TABLE IF NOT EXISTS |CREATE TABLE |INSERT INTO |INSERT IGNORE INTO |REPLACE INTO )`([^`]+)`/',
		fn( $m ) => $m[1] . '`' . rename_table( $m[2] ) . '`',
		$sql
	);
	if ( str_starts_with( $sql, 'CREATE TABLE' ) ) {
		$sql = preg_replace_callback( '/\bREFERENCES `([^`]+)`/', fn( $m ) => 'REFERENCES `' . rename_table( $m[1] ) . '`', $sql );
	}
	return $sql;
}

// True when the lexer reads the whole buffer and its last token is ";".
function ends_statement( string $sql ): bool {
	$lexer = new WP_MySQL_Lexer( $sql );
	$last  = null;
	while ( $lexer->next_token() ) {
		$token = $lexer->get_token();
		if ( WP_MySQL_Lexer::EOF === $token->id ) {
			break;
		}
		$last = $token->id;
	}
	$token = $lexer->get_token();
	return WP_MySQL_Lexer::SEMICOLON_SYMBOL === $last && null !== $token && WP_MySQL_Lexer::EOF === $token->id;
}

$db = new WP_MySQL_On_SQLite(
	sprintf( 'mysql-on-sqlite:path=%s;dbname=%s', $out, str_replace( ';', ';;', $dbname ) )
);
$db->query( "SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO'" );

// Pass 2: run the statements, in one transaction.
$in      = fopen( $dump, 'rb' );
$buf     = '';
$count   = 0;
$line_no = 0;
$db->query( 'BEGIN' );
while ( false !== ( $line = fgets( $in ) ) ) {
	$line_no++;
	if ( '' === $buf ) {
		$t = ltrim( $line );
		if ( '' === trim( $t ) || str_starts_with( $t, '-- ' ) || '--' === rtrim( $t ) || str_starts_with( $t, '#' )
			|| str_starts_with( $t, '/*!' ) || str_starts_with( $t, '/*M!' )
			|| preg_match( '/^(LOCK|UNLOCK)\s+TABLES\b/i', $t ) ) {
			continue;
		}
	}
	$buf .= $line;
	if ( ! str_ends_with( rtrim( $line ), ';' ) || ! ends_statement( $buf ) ) {
		continue;
	}
	$count++;
	try {
		$db->query( rename_statement( $buf ) );
	} catch ( Throwable $e ) {
		fwrite( STDERR, sprintf( "statement %d (ends at line %d) failed: %s\n  %s\n", $count, $line_no, $e->getMessage(), substr( $buf, 0, 200 ) ) );
		if ( preg_match( '/\b_(binary|utf8mb4|utf8mb3|utf8|latin1)\s*\'/i', $buf ) ) {
			fwrite( STDERR, "The statement has a character set introducer (for example _binary '...'). The driver does not read it.\nMake the dump again with --hex-blob (mysqldump --hex-blob, or wp db export --hex-blob).\n" );
		}
		exit( 1 );
	}
	$buf = '';
}
fclose( $in );
if ( '' !== trim( $buf ) ) {
	fail( sprintf( 'the dump ends inside a statement (line %d): %s', $line_no, substr( $buf, 0, 200 ) ) );
}

// The keys that WordPress names with the prefix.
$changed = array( 'options' => 0, 'usermeta' => 0 );
if ( NEW_PREFIX !== $old ) {
	$n = strlen( $old );
	$changed['options']  = $db->query( 'UPDATE `wp_options` SET option_name = ' . q( NEW_PREFIX . 'user_roles' ) . ' WHERE option_name = ' . q( $old . 'user_roles' ) )->rowCount();
	$changed['usermeta'] = $db->query( 'UPDATE `wp_usermeta` SET meta_key = CONCAT(' . q( NEW_PREFIX ) . ', SUBSTRING(meta_key, ' . ( $n + 1 ) . ')) WHERE SUBSTRING(meta_key, 1, ' . $n . ') = ' . q( $old ) )->rowCount();
}
$db->query( 'COMMIT' );

$rows = array();
$other = array();
foreach ( $db->query( 'SHOW TABLES' )->fetchAll( PDO::FETCH_NUM ) as [ $table ] ) {
	$rows[ $table ] = (int) $db->query( 'SELECT COUNT(*) FROM `' . str_replace( '`', '``', $table ) . '`' )->fetchColumn();
	if ( ! str_starts_with( $table, NEW_PREFIX ) ) {
		$other[] = $table;
	}
}
$site = array();
foreach ( array( 'home', 'siteurl', 'template', 'stylesheet', 'active_plugins', 'db_version' ) as $name ) {
	$v = $db->query( 'SELECT option_value FROM `wp_options` WHERE option_name = ' . q( $name ) )->fetchColumn();
	if ( 'active_plugins' === $name && is_string( $v ) ) {
		$list = @unserialize( $v, array( 'allowed_classes' => false ) );
		$v    = is_array( $list ) ? array_values( $list ) : $v;
	}
	$site[ $name ] = false === $v ? null : $v;
}
echo json_encode(
	array(
		'prefix'         => $old,
		'renamed'        => NEW_PREFIX !== $old,
		'keys_changed'   => $changed,
		'statements'     => $count,
		'rows'           => $rows,
		'without_prefix' => $other,
		'site'           => $site,
	),
	JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
), "\n";
