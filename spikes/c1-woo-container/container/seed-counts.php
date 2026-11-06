<?php
// The rows of each table of a SQLite file, as JSON (issue #31, the import).
// entrypoint.sh runs it on the seed before PHP's server starts, and
// stats.php what=seed returns the result; deploy/import.sh compares it with
// the same count of the seed it sent (deploy/import/dbmove-file.py
// sqlite-counts). Tables named sqlite_* are not counted.
//
//   php seed-counts.php <file.sqlite> <sha256> <replica_path>
if ( $argc !== 4 ) {
	fwrite( STDERR, "usage: php seed-counts.php <file.sqlite> <sha256> <replica_path>\n" );
	exit( 2 );
}
$db   = new PDO( 'sqlite:' . $argv[1], null, null, array( PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION ) );
$rows = array();
$names = $db->query( "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name" )->fetchAll( PDO::FETCH_COLUMN );
foreach ( $names as $t ) {
	$rows[ $t ] = (int) $db->query( 'SELECT COUNT(*) FROM "' . str_replace( '"', '""', $t ) . '"' )->fetchColumn();
}
echo json_encode( array( 'sha256' => $argv[2], 'replica_path' => $argv[3], 'rows' => $rows ), JSON_UNESCAPED_SLASHES ), "\n";
