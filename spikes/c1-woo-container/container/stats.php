<?php
// Spike only: what the container measured, for the concurrency work
// (docs/approach-c1.md, "Where c1 saturates"). Needs the x-spike-token header.
//
//   ?what=info      instance, PHP, OPcache, SQLite journal mode (JSON)
//   ?what=req       one line per request (router.php): start, wall s, CPU s,
//                   peak MiB, status, method, path
//   ?what=samples   one line every 2 s (entrypoint.sh): time, /proc/stat cpu,
//                   cgroup cpu.stat, load, accept backlog, PHP processes
//   ?what=purge     one line per page cache purge request (php/c1-purge-log.php)
//   ?what=db        row counts and sizes that grow as a store sells (JSON)
//   ?what=apcu      APCu: entries, memory, hits, misses, and the PHP worker
//                   that answered (call it several times: one shared cache
//                   gives the same start_time and growing counts in every pid)
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
if ( 'req' === $what || 'samples' === $what || 'purge' === $what ) {
	header( 'content-type: text/plain' );
	$f = array( 'req' => '/tmp/c1-req.log', 'samples' => '/tmp/c1-samples.log', 'purge' => '/tmp/c1-purge.log' )[ $what ];
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
if ( 'apcu' === $what ) {
	header( 'content-type: application/json' );
	if ( ! function_exists( 'apcu_enabled' ) || ! apcu_enabled() ) {
		exit( json_encode( array( 'pid' => getmypid(), 'apcu' => false ) ) );
	}
	$ci  = apcu_cache_info( true );
	$sma = apcu_sma_info( true );
	exit(
		json_encode(
			array(
				'pid'        => getmypid(),
				'apcu'       => true,
				'start_time' => $ci['start_time'],
				'entries'    => $ci['num_entries'],
				'hits'       => $ci['num_hits'],
				'misses'     => $ci['num_misses'],
				'inserts'    => $ci['num_inserts'],
				'expunges'   => $ci['expunges'],
				'mem_mib'    => round( $ci['mem_size'] / 1048576, 1 ),
				'avail_mib'  => round( $sma['avail_mem'] / 1048576, 1 ),
				'drop_in'    => is_file( __DIR__ . '/wp-content/object-cache.php' ),
			)
		)
	);
}
if ( 'db' === $what ) {
	header( 'content-type: application/json' );
	$db  = new PDO( 'sqlite:/data/wordpress.sqlite' );
	$one = function ( $sql ) use ( $db ) {
		try {
			return $db->query( $sql )->fetchColumn();
		} catch ( Exception $e ) {
			return null;
		}
	};
	$out = array(
		'db_bytes'  => @filesize( '/data/wordpress.sqlite' ),
		'wal_bytes' => @filesize( '/data/wordpress.sqlite-wal' ),
		'pages'     => (int) $one( 'PRAGMA page_count' ),
		'freelist'  => (int) $one( 'PRAGMA freelist_count' ),
		'rows'      => array(),
	);
	foreach ( array( 'wp_posts', 'wp_postmeta', 'wp_options', 'wp_comments', 'wp_wc_orders', 'wp_wc_orders_meta', 'wp_wc_order_addresses', 'wp_wc_order_operational_data', 'wp_woocommerce_order_items', 'wp_woocommerce_order_itemmeta', 'wp_woocommerce_sessions', 'wp_wc_order_stats', 'wp_wc_order_product_lookup', 'wp_wc_customer_lookup', 'wp_actionscheduler_actions', 'wp_actionscheduler_logs' ) as $t ) {
		$out['rows'][ $t ] = $one( "SELECT COUNT(*) FROM \"$t\"" );
	}
	$out['autoload_rows']  = $one( "SELECT COUNT(*) FROM wp_options WHERE autoload IN ('yes','on','auto-on','auto')" );
	$out['autoload_bytes'] = $one( "SELECT SUM(LENGTH(option_value)) FROM wp_options WHERE autoload IN ('yes','on','auto-on','auto')" );
	$out['transients']     = $one( "SELECT COUNT(*) FROM wp_options WHERE option_name LIKE '\\_transient\\_%' ESCAPE '\\'" );
	$out['post_types']     = array();
	try {
		foreach ( $db->query( 'SELECT post_type, COUNT(*) n FROM wp_posts GROUP BY post_type ORDER BY n DESC LIMIT 12' ) as $r ) {
			$out['post_types'][ $r['post_type'] ] = (int) $r['n'];
		}
		$out['actions'] = array();
		foreach ( $db->query( 'SELECT status, COUNT(*) n FROM wp_actionscheduler_actions GROUP BY status' ) as $r ) {
			$out['actions'][ $r['status'] ] = (int) $r['n'];
		}
	} catch ( Exception $e ) {
		$out['error'] = $e->getMessage();
	}
	exit( json_encode( $out ) );
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
	'drop_in'     => is_file( __DIR__ . '/wp-content/object-cache.php' ),
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
