<?php
// Spike only: what the container measured, for the concurrency work
// (docs/approach-c1.md, "Where c1 saturates"). Needs the x-spike-token header.
//
//   ?what=info      instance, PHP, OPcache, SQLite journal mode (JSON)
//   ?what=req       one line per request (router.php): start, wall s, CPU s,
//                   peak MiB, status, method, path
//   ?what=samples   one line every 2 s (entrypoint.sh): time, /proc/stat cpu,
//                   cgroup cpu.stat, load, accept backlog, PHP processes
//   &since=<epoch>  only lines from that time
//
// The files are read after a load run, not during it: during a run this
// request waits behind the load in the same PHP workers.
$token = getenv( 'SPIKE_TOKEN' );
if ( ! $token || ! hash_equals( $token, (string) ( $_SERVER['HTTP_X_SPIKE_TOKEN'] ?? '' ) ) ) {
	http_response_code( 403 );
	exit( 'forbidden' );
}
header( 'cache-control: private, no-store' );
$what  = $_GET['what'] ?? 'info';
$since = (float) ( $_GET['since'] ?? 0 );
if ( 'req' === $what || 'samples' === $what ) {
	header( 'content-type: text/plain' );
	$f = 'req' === $what ? '/tmp/c1-req.log' : '/tmp/c1-samples.log';
	$h = @fopen( $f, 'r' );
	if ( ! $h ) {
		exit;
	}
	while ( false !== ( $line = fgets( $h ) ) ) {
		if ( (float) strtok( $line, ' ' ) >= $since ) {
			echo $line;
		}
	}
	exit;
}
$info = array(
	'sapi'        => PHP_SAPI,
	'php'         => PHP_VERSION,
	'php_workers' => getenv( 'PHP_CLI_SERVER_WORKERS' ),
	'nproc'       => (int) trim( (string) shell_exec( 'nproc' ) ),
	'cpu_max'     => trim( (string) @file_get_contents( '/sys/fs/cgroup/cpu.max' ) ),
	'mem_total'   => trim( (string) shell_exec( "awk '/MemTotal/ {print \$2}' /proc/meminfo" ) ),
	'loadavg'     => trim( (string) @file_get_contents( '/proc/loadavg' ) ),
	'apcu'        => function_exists( 'apcu_enabled' ) && apcu_enabled(),
);
if ( function_exists( 'opcache_get_status' ) ) {
	$o = opcache_get_status( false );
	if ( $o ) {
		$info['opcache'] = array(
			'enabled'   => $o['opcache_enabled'],
			'full'      => $o['cache_full'],
			'used_mib'  => round( $o['memory_usage']['used_memory'] / 1048576, 1 ),
			'free_mib'  => round( $o['memory_usage']['free_memory'] / 1048576, 1 ),
			'scripts'   => $o['opcache_statistics']['num_cached_scripts'],
			'hit_rate'  => round( $o['opcache_statistics']['opcache_hit_rate'], 2 ),
			'oom'       => $o['opcache_statistics']['oom_restarts'],
		);
	}
	$info['validate_timestamps'] = ini_get( 'opcache.validate_timestamps' );
}
try {
	// journal_mode=WAL is stored in the file, so a new connection reads it.
	// busy_timeout is per connection: the driver sets it (10000 ms default).
	$db                   = new PDO( 'sqlite:/data/wordpress.sqlite' );
	$info['journal_mode'] = $db->query( 'PRAGMA journal_mode' )->fetchColumn();
	$info['wal_bytes']    = @filesize( '/data/wordpress.sqlite-wal' );
	$info['db_bytes']     = @filesize( '/data/wordpress.sqlite' );
} catch ( Exception $e ) {
	$info['journal_mode'] = 'error: ' . $e->getMessage();
}
header( 'content-type: application/json' );
echo json_encode( $info );
