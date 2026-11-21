<?php
/**
 * Local spike runner for issue 1258.
 *
 * A normal request runs this file in the site PHP runtime. It is not a product
 * path. The harness adds it to the local site zip, then removes it.
 *
 * mode=probe       report the runtime. Do not start WP-CLI.
 * mode=phar        include wp-cli.phar. This is the real entry.
 * mode=inner       load wp-cli.php from the phar after the SAPI check in
 *                  boot-phar.php. This is a probe. It is not the real entry.
 * polyfill=1       define STDOUT and STDERR when the SAPI did not. inner only.
 *
 * cmd is one of: option-get, user-list, cache-flush, cron-list, plugin-install.
 */

header( 'Content-Type: text/plain; charset=utf-8' );
header( 'Cache-Control: no-store' );

$mode = isset( $_GET['mode'] ) ? (string) $_GET['mode'] : 'probe';
$cmd = isset( $_GET['cmd'] ) ? (string) $_GET['cmd'] : '';
$polyfill = isset( $_GET['polyfill'] ) && $_GET['polyfill'] === '1';
$phar_path = '/wordpress/wp-cli.phar';
$started = microtime( true );
$level = ob_get_level();

$commands = array(
	'option-get' => array( 'wp', 'option', 'get', 'siteurl' ),
	'user-list' => array( 'wp', 'user', 'list' ),
	'cache-flush' => array( 'wp', 'cache', 'flush' ),
	'cron-list' => array( 'wp', 'cron', 'event', 'list' ),
	'plugin-install' => array( 'wp', 'plugin', 'install', 'hello-dolly' ),
);

$fn_names = array(
	'proc_open', 'popen', 'exec', 'shell_exec', 'system', 'passthru',
	'pcntl_exec', 'pcntl_fork', 'posix_isatty', 'stream_isatty',
	'fsockopen', 'curl_exec',
);

$result = array(
	'mode' => $mode,
	'cmd' => $cmd,
	'php' => PHP_VERSION,
	'sapi' => PHP_SAPI,
	'polyfill_requested' => $polyfill,
);

function pf1258_fn_map( $names ) {
	$out = array();
	foreach ( $names as $name ) {
		$out[ $name ] = function_exists( $name );
	}
	return $out;
}

function pf1258_stream( $url ) {
	$fp = @fopen( $url, 'w' );
	if ( ! $fp ) {
		$fp = @fopen( $url, 'r' );
	}
	if ( ! is_resource( $fp ) ) {
		return array( 'open' => false );
	}
	$meta = stream_get_meta_data( $fp );
	fclose( $fp );
	return array(
		'open' => true,
		'wrapper_type' => isset( $meta['wrapper_type'] ) ? $meta['wrapper_type'] : null,
	);
}

function pf1258_version( $phar_path ) {
	$paths = array(
		'phar://' . $phar_path . '/vendor/wp-cli/wp-cli/VERSION',
		'phar://' . $phar_path . '/VERSION',
	);
	foreach ( $paths as $path ) {
		$text = @file_get_contents( $path );
		if ( is_string( $text ) && $text !== '' ) {
			return array( 'path' => $path, 'text' => trim( $text ) );
		}
	}
	return null;
}

function pf1258_root( $phar_path ) {
	$candidates = array(
		'phar://' . $phar_path . '/vendor/wp-cli/wp-cli',
		'phar://' . $phar_path,
	);
	foreach ( $candidates as $root ) {
		if ( file_exists( $root . '/php/wp-cli.php' ) ) {
			return $root;
		}
	}
	return null;
}

ob_start();

register_shutdown_function( function () use ( &$result, $started, $level ) {
	$err = error_get_last();
	if ( $err && in_array( $err['type'], array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR ), true ) ) {
		$result['ok'] = false;
		$result['fatal'] = array(
			'type' => $err['type'],
			'message' => $err['message'],
			'file' => $err['file'],
			'line' => $err['line'],
		);
	}
	$text = '';
	while ( ob_get_level() > $level ) {
		$text .= (string) ob_get_clean();
	}
	$result['output'] = $text;
	$result['peak'] = function_exists( 'memory_get_peak_usage' ) ? memory_get_peak_usage( true ) : null;
	$result['seconds'] = round( microtime( true ) - $started, 3 );
	echo "PF1258_JSON\n";
	echo json_encode( $result, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE );
	echo "\n";
} );

if ( $mode === 'probe' ) {
	$phar_err = null;
	$phar_count = null;
	if ( class_exists( 'Phar' ) && is_file( $phar_path ) ) {
		try {
			$phar = new Phar( $phar_path );
			$phar_count = $phar->count();
		} catch ( Throwable $e ) {
			$phar_err = $e->getMessage();
		}
	}
	$runtime = @file_get_contents( '/wordpress/wp-runtime.php' );
	$disabled = ini_get( 'disable_functions' );
	$result['ok'] = true;
	$result['probe'] = array(
		'phar_file' => is_file( $phar_path ),
		'phar_bytes' => is_file( $phar_path ) ? filesize( $phar_path ) : null,
		'extension_phar' => extension_loaded( 'phar' ),
		'class_phar' => class_exists( 'Phar' ),
		'phar_readonly' => ini_get( 'phar.readonly' ),
		'phar_count' => $phar_count,
		'phar_error' => $phar_err,
		'phar_root' => pf1258_root( $phar_path ),
		'version' => pf1258_version( $phar_path ),
		'memory_limit' => ini_get( 'memory_limit' ),
		'max_execution_time' => ini_get( 'max_execution_time' ),
		'disable_functions' => $disabled === false ? null : $disabled,
		'open_basedir' => ini_get( 'open_basedir' ),
		'allow_url_fopen' => ini_get( 'allow_url_fopen' ),
		'variables_order' => ini_get( 'variables_order' ),
		'functions' => pf1258_fn_map( $fn_names ),
		'const_stdin' => defined( 'STDIN' ),
		'const_stdout' => defined( 'STDOUT' ),
		'const_stderr' => defined( 'STDERR' ),
		'php_stdin' => pf1258_stream( 'php://stdin' ),
		'php_stdout' => pf1258_stream( 'php://stdout' ),
		'php_stderr' => pf1258_stream( 'php://stderr' ),
		'php_output' => pf1258_stream( 'php://output' ),
		'use_zend_alloc_usage' => memory_get_usage( true ),
		'runtime_php_exists' => is_string( $runtime ),
		'runtime_defines_disallow_file_mods' => is_string( $runtime ) && strpos( $runtime, "define('DISALLOW_FILE_MODS', true);" ) !== false,
		'runtime_defines_code_lock' => is_string( $runtime ) && strpos( $runtime, "define('SKYPHUSION_CODE_LOCK', true);" ) !== false,
	);
} elseif ( $mode === 'phar' || $mode === 'inner' ) {
	if ( ! isset( $commands[ $cmd ] ) ) {
		$result['ok'] = false;
		$result['error'] = 'unknown cmd';
	} elseif ( ! is_file( $phar_path ) ) {
		$result['ok'] = false;
		$result['error'] = 'phar missing';
	} else {
		$argv = $commands[ $cmd ];
		$GLOBALS['argv'] = $argv;
		$GLOBALS['argc'] = count( $argv );
		$_SERVER['argv'] = $argv;
		$_SERVER['argc'] = count( $argv );
		$result['argv'] = $argv;
		$result['term'] = getenv( 'TERM' ) === false ? null : getenv( 'TERM' );
		if ( isset( $_GET['term'] ) && $_GET['term'] === 'off' ) {
			putenv( 'TERM' );
			unset( $_ENV['TERM'], $_SERVER['TERM'] );
			$result['term_cleared'] = true;
			$result['term_after'] = getenv( 'TERM' ) === false ? null : getenv( 'TERM' );
		}
		chdir( '/wordpress' );
		$result['cwd'] = getcwd();
		$result['stdout_polyfill'] = false;
		if ( $mode === 'inner' && $polyfill ) {
			if ( ! defined( 'STDOUT' ) ) {
				$stdout = @fopen( 'php://stdout', 'w' );
				$result['stdout_polyfill_target'] = 'php://stdout';
				if ( ! $stdout ) {
					$stdout = @fopen( 'php://output', 'w' );
					$result['stdout_polyfill_target'] = 'php://output';
				}
				if ( $stdout ) {
					define( 'STDOUT', $stdout );
					$result['stdout_polyfill'] = true;
				}
			}
			if ( ! defined( 'STDERR' ) ) {
				$stderr = @fopen( 'php://stderr', 'w' );
				if ( $stderr ) {
					define( 'STDERR', $stderr );
					$result['stderr_polyfill'] = true;
				}
			}
		}
		try {
			if ( $mode === 'phar' ) {
				include $phar_path;
				$result['ok'] = true;
				$result['note'] = 'include returned';
			} else {
				$root = pf1258_root( $phar_path );
				$result['root'] = $root;
				if ( ! $root ) {
					$result['ok'] = false;
					$result['error'] = 'wp-cli.php not in phar';
				} else {
					if ( ! defined( 'WP_CLI_PHAR_PATH' ) ) {
						define( 'WP_CLI_PHAR_PATH', getcwd() );
					}
					if ( ! defined( 'WP_CLI_ROOT' ) ) {
						define( 'WP_CLI_ROOT', $root );
					}
					include $root . '/php/wp-cli.php';
					$result['ok'] = true;
					$result['note'] = 'include returned';
				}
			}
		} catch ( Throwable $e ) {
			$result['ok'] = false;
			$result['exception'] = get_class( $e );
			$result['error'] = $e->getMessage();
			$result['file'] = $e->getFile();
			$result['line'] = $e->getLine();
		}
	}
} else {
	$result['ok'] = false;
	$result['error'] = 'unknown mode';
}
