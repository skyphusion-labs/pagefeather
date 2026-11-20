<?php
/**
 * #998: a REST plugin activate that fatals returns the fatal JSON, not an empty 500.
 * No fixture shim: stock core 7.1.4 does not define WP_Theme_JSON_Resolver_Gutenberg, so neither do we.
 * Run: php spikes/b2-wordpress/tests/plugin-activate-fatal-test.php
 */
$fails = 0;
function ok( $label, $cond ) {
	global $fails;
	echo ( $cond ? 'PASS ' : 'FAIL ' ) . $label . "\n";
	if ( ! $cond ) {
		$fails++;
	}
}
function run_php( $code ) {
	$cmd = array( PHP_BINARY, '-d', 'display_errors=0', '-d', 'log_errors=0', '-r', $code );
	$spec = array( 0 => array( 'pipe', 'r' ), 1 => array( 'pipe', 'w' ), 2 => array( 'pipe', 'w' ) );
	$proc = proc_open( $cmd, $spec, $pipes );
	fclose( $pipes[0] );
	$out = stream_get_contents( $pipes[1] );
	$err = stream_get_contents( $pipes[2] );
	fclose( $pipes[1] );
	fclose( $pipes[2] );
	$status = proc_close( $proc );
	return array( $status, $out, $err );
}

$php = dirname( __DIR__ ) . '/php/plugin-activate-fatal.php';
$build = dirname( __DIR__ ) . '/build.sh';
$build_src = file_get_contents( $build );
ok( 'build.sh copies the mu-plugin', false !== strpos( $build_src, 'php/plugin-activate-fatal.php' ) );

$GLOBALS['actions'] = array();
function add_action( $hook, $cb, $priority = 10 ) {
	$GLOBALS['actions'][] = array( $hook, $cb, $priority );
}
require $php;

ok( 'no plugin hook is registered', array() === $GLOBALS['actions'] );
ok( 'no Gutenberg resolver shim is defined', ! function_exists( 'skyphusion_alias_gutenberg_theme_json_resolver' ) && ! class_exists( 'WP_Theme_JSON_Resolver_Gutenberg', false ) );

$fatal = array( 'type' => E_ERROR, 'message' => "Uncaught Error: Class \"Nope\" not found in plugin.php:59\nStack trace:\n#0 {main}", 'file' => '/wordpress/wp-content/plugins/gutenberg-test-plugins/delete-installed-fonts.php', 'line' => 59 );
ok( 'sandbox REST fatal is reported', skyphusion_plugin_activate_should_report( $fatal, true, true ) );
ok( 'a warning is not reported', ! skyphusion_plugin_activate_should_report( array( 'type' => E_USER_WARNING, 'message' => 'x' ), true, true ) );
ok( 'a non-REST fatal is not reported', ! skyphusion_plugin_activate_should_report( $fatal, true, false ) );
ok( 'a REST fatal outside the sandbox is not reported', ! skyphusion_plugin_activate_should_report( $fatal, false, true ) );
ok( 'no error is not reported', ! skyphusion_plugin_activate_should_report( null, true, true ) );
$payload = skyphusion_plugin_activate_fatal_payload( $fatal );
ok( 'payload keeps the first line, file, and line', 'rest_plugin_activate_fatal' === $payload['code'] && false === strpos( $payload['message'], "\n" ) && false !== strpos( $payload['message'], 'Class "Nope" not found' ) && 59 === $payload['data']['line'] && false !== strpos( $payload['data']['file'], 'delete-installed-fonts.php' ) && 500 === $payload['data']['status'] );

$req = var_export( $php, true );
$bare = run_php( 'define("WP_SANDBOX_SCRAPING", true); define("REST_REQUEST", true); ob_start(); echo "hidden"; NoSuchActivate998::missing();' );
ok( 'without the mu-plugin the buffer is the body and the class name is absent', 255 === $bare[0] && 'hidden' === $bare[1] && false === strpos( $bare[1], 'NoSuchActivate998' ) );
$fixed = run_php( 'require ' . $req . '; define("WP_SANDBOX_SCRAPING", true); define("REST_REQUEST", true); ob_start(); echo "hidden"; NoSuchActivate998::missing();' );
$json = json_decode( $fixed[1], true );
ok( 'with the mu-plugin the body is the fatal JSON', 255 === $fixed[0] && is_array( $json ) && isset( $json['message'] ) && false !== strpos( $json['message'], 'Class "NoSuchActivate998" not found' ) && false === strpos( $fixed[1], 'hidden' ) && 500 === $json['data']['status'] );
$admin = run_php( 'require ' . $req . '; define("WP_SANDBOX_SCRAPING", true); ob_start(); echo "hidden"; NoSuchActivate998::missing();' );
ok( 'a non-REST sandbox fatal keeps its buffer', 255 === $admin[0] && 'hidden' === $admin[1] );
$plain = run_php( 'require ' . $req . '; define("REST_REQUEST", true); ob_start(); echo "hidden"; NoSuchActivate998::missing();' );
ok( 'a REST fatal outside the sandbox keeps its buffer', 255 === $plain[0] && 'hidden' === $plain[1] );
$warn = run_php( 'require ' . $req . '; define("WP_SANDBOX_SCRAPING", true); define("REST_REQUEST", true); ob_start(); echo "ok"; trigger_error("nope", E_USER_WARNING); echo "done";' );
ok( 'a warning does not replace the body', 0 === $warn[0] && 'okdone' === $warn[1] );

echo $fails . " failing\n";
exit( $fails ? 1 : 0 );
