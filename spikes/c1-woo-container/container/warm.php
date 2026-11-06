<?php
// Warm PHP after a container start (issue #92). c1-serve.sh calls it once per
// start, from inside the container, through nginx on 127.0.0.1:8081 only
// (nginx.conf): the Worker reaches port 80 only, so no request from outside
// can run this file.
//
// Measured 2026-11-06 (docs/approach-c1.md, "Where the warm 5 s goes"): with
// the container ready in time, the first PHP request after a start took 5.04 s
// wall, 2.18 s CPU, and the next 0.26 s, 0.20 s. OPcache and APCu are shared
// memory of the PHP-FPM master, so one FPM request warms them for every child.
// A CLI run would warm nothing.
//
// 1. Boot WordPress and WooCommerce (wp-load.php), as a shopper request does,
//    with the output dropped. No query runs (wp() is not called), WP-Cron does
//    not spawn (DISABLE_WP_CRON), and no header is sent, so no cookie leaves.
// 2. Compile the Store API files (the cart path) that a boot does not load,
//    with opcache_compile_file(): it compiles a file without running it. It
//    stops at WARM_MAX_FILES files, or when OPcache has less than 16 MiB free,
//    so it cannot cause an OPcache restart (which would empty the cache).
// The answer is one JSON line, and the x-c1-warm header says the same, so a
// caller can tell that this file ran.
$c1w_t0     = microtime( true );
$c1w_status = function () {
	$o = function_exists( 'opcache_get_status' ) ? opcache_get_status( false ) : false;
	return $o ? array( 'scripts' => $o['opcache_statistics']['num_cached_scripts'], 'free_mib' => round( $o['memory_usage']['free_memory'] / 1048576, 1 ) ) : null;
};
$c1w_before = $c1w_status();
define( 'DISABLE_WP_CRON', true );
$_SERVER['HTTP_HOST']   = getenv( 'PUBLIC_HOST' ) ?: 'localhost';
$_SERVER['REQUEST_URI'] = '/';
ob_start();
require '/var/www/html/wp-load.php';
ob_end_clean();
$c1w_boot = microtime( true ) - $c1w_t0;
$c1w_n    = 0;
$c1w_stop = 'done';
$c1w_max  = (int) ( getenv( 'WARM_MAX_FILES' ) ?: 3000 );
$c1w_dir  = WP_PLUGIN_DIR . '/woocommerce/src/StoreApi';
if ( function_exists( 'opcache_compile_file' ) && is_dir( $c1w_dir ) ) {
	$c1w_it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $c1w_dir, FilesystemIterator::SKIP_DOTS ) );
	foreach ( $c1w_it as $c1w_f ) {
		if ( 'php' !== $c1w_f->getExtension() ) {
			continue;
		}
		if ( $c1w_n >= $c1w_max ) {
			$c1w_stop = 'max files';
			break;
		}
		$c1w_s = $c1w_status();
		if ( $c1w_s && $c1w_s['free_mib'] < 16 ) {
			$c1w_stop = 'opcache free below 16 MiB';
			break;
		}
		if ( ! opcache_is_script_cached( $c1w_f->getPathname() ) && @opcache_compile_file( $c1w_f->getPathname() ) ) {
			++$c1w_n;
		}
	}
} else {
	$c1w_stop = 'no opcache_compile_file or no StoreApi';
}
$c1w_out = array(
	'boot_s'   => round( $c1w_boot, 3 ),
	'total_s'  => round( microtime( true ) - $c1w_t0, 3 ),
	'compiled' => $c1w_n,
	'stop'     => $c1w_stop,
	'before'   => $c1w_before,
	'after'    => $c1w_status(),
);
// No header that WordPress or a plugin set leaves this request: no cookie, no
// session.
header_remove();
header( 'content-type: application/json' );
header( 'cache-control: no-store' );
header( 'x-c1-warm: ' . json_encode( $c1w_out ) );
echo json_encode( $c1w_out ), "\n";
