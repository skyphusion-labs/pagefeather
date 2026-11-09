<?php
// php tests/turnstile-forms-test.php
// Unit test for php/turnstile-forms.php with minimal WordPress stubs. Proves each
// form gates (good token proceeds, bad or missing token is rejected), the widget
// ships the public site key, and the off switches restore the unprotected form.
// Each scenario defines a different set of SKYPHUSION_TURNSTILE_* constants, which
// PHP cannot redefine in one process, so the driver runs each in its own process.

$scenario = getenv( 'TS_SCENARIO' );
if ( false === $scenario || '' === $scenario ) {
	$fail = 0;
	foreach ( array( 'all', 'master-off', 'login-off' ) as $sc ) {
		echo "== scenario: $sc ==\n";
		$cmd = 'TS_SCENARIO=' . $sc . ' ' . escapeshellarg( PHP_BINARY ) . ' ' . escapeshellarg( __FILE__ );
		passthru( $cmd, $code );
		if ( 0 !== $code ) {
			$fail++;
		}
	}
	echo $fail ? "\n$fail SCENARIO(S) FAILED\n" : "\nALL SCENARIOS PASS\n";
	exit( $fail ? 1 : 0 );
}

// ---- Assertions. ----
$fail = 0;
function check( $label, $got, $want ) {
	global $fail;
	if ( $got === $want ) { echo "ok   $label\n"; return; }
	$fail++; echo "FAIL $label\n  got:  " . var_export( $got, true ) . "\n  want: " . var_export( $want, true ) . "\n";
}

// ---- Minimal WordPress stubs. ----
$GLOBALS['hooks'] = array();
function add_action( $hook, $cb, $prio = 10, $args = 1 ) { $GLOBALS['hooks'][ $hook ][] = $cb; }
function add_filter( $hook, $cb, $prio = 10, $args = 1 ) { $GLOBALS['hooks'][ $hook ][] = $cb; }
function has_hook( $hook ) { return ! empty( $GLOBALS['hooks'][ $hook ] ); }
function do_action( $hook, ...$args ) {
	foreach ( $GLOBALS['hooks'][ $hook ] ?? array() as $cb ) { call_user_func_array( $cb, $args ); }
}
function apply_filters( $hook, $value, ...$args ) {
	foreach ( $GLOBALS['hooks'][ $hook ] ?? array() as $cb ) {
		$value = call_user_func_array( $cb, array_merge( array( $value ), $args ) );
	}
	return $value;
}
function __( $s, $d = 'default' ) { return $s; }
function esc_html__( $s, $d = 'default' ) { return $s; }
function esc_attr( $s ) { return htmlspecialchars( (string) $s, ENT_QUOTES ); }
function esc_html( $s ) { return htmlspecialchars( (string) $s, ENT_QUOTES ); }
function sanitize_text_field( $s ) { return trim( preg_replace( '/[\r\n\t ]+/', ' ', (string) $s ) ); }
function wp_unslash( $s ) { return is_string( $s ) ? stripslashes( $s ) : $s; }
function wp_json_encode( $v ) { return json_encode( $v ); }
function is_admin() { return false; }

class WP_Error {
	public $code;
	public $message;
	public function __construct( $code = '', $message = '' ) { $this->code = $code; $this->message = $message; }
}
class WpDieException extends Exception {
	public $args;
	public function __construct( $message, $title, $args ) { parent::__construct( $message ); $this->args = $args; }
}
function wp_die( $message = '', $title = '', $args = array() ) { throw new WpDieException( $message, $title, $args ); }

$GLOBALS['wc_notices'] = array();
function wc_add_notice( $text, $type = 'success' ) { $GLOBALS['wc_notices'][] = array( $text, $type ); }

// ---- The worker-call stub: returns whatever the current test queued. ----
$GLOBALS['ts_reply']  = '{"ok":true,"success":true}';
$GLOBALS['ts_calls']  = 0;
function skyphusion_worker_call( $json ) { $GLOBALS['ts_calls']++; return $GLOBALS['ts_reply']; }

// ---- Scenario defines, then load the plugin once. ----
define( 'SKYPHUSION_TURNSTILE_SITEKEY', '1x00000000000000000000AA' );
switch ( $scenario ) {
	case 'master-off':
		define( 'SKYPHUSION_TURNSTILE', false );
		break;
	case 'login-off':
		define( 'SKYPHUSION_TURNSTILE', true );
		define( 'SKYPHUSION_TURNSTILE_LOGIN', false );
		break;
	case 'all':
	default:
		define( 'SKYPHUSION_TURNSTILE', true );
		break;
}
require __DIR__ . '/../php/turnstile-forms.php';

// Helper: queue a worker reply and reset the call counter.
function ts_reply( $arr ) { $GLOBALS['ts_reply'] = json_encode( $arr ); $GLOBALS['ts_calls'] = 0; }

if ( 'master-off' === $scenario ) {
	check( 'master off: no hooks registered', empty( $GLOBALS['hooks'] ), true );
	check( 'master off: widget function not defined', function_exists( 'skyphusion_turnstile_widget' ), false );
	echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
	exit( $fail ? 1 : 0 );
}

if ( 'login-off' === $scenario ) {
	check( 'login off: authenticate not hooked', has_hook( 'authenticate' ), false );
	check( 'login off: login_form not hooked', has_hook( 'login_form' ), false );
	check( 'login off: comments still hooked', has_hook( 'preprocess_comment' ), true );
	check( 'login off: checkout still hooked', has_hook( 'woocommerce_checkout_process' ), true );
	echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
	exit( $fail ? 1 : 0 );
}

// ---- scenario: all ----

// 0) Every form hook is registered.
check( 'login_form hooked', has_hook( 'login_form' ), true );
check( 'authenticate hooked', has_hook( 'authenticate' ), true );
check( 'preprocess_comment hooked', has_hook( 'preprocess_comment' ), true );
check( 'comment_form_after_fields hooked', has_hook( 'comment_form_after_fields' ), true );
check( 'woocommerce_checkout_process hooked', has_hook( 'woocommerce_checkout_process' ), true );

// 1) The widget ships the public site key, the Spin marker and the api.js script.
ob_start();
do_action( 'login_form' );
$widget = ob_get_clean();
check( 'widget carries the public site key', (bool) strpos( $widget, 'data-sitekey="1x00000000000000000000AA"' ), true );
check( 'widget carries the cf-turnstile class', (bool) strpos( $widget, 'class="cf-turnstile"' ), true );
check( 'widget carries the Spin telemetry marker', (bool) strpos( $widget, 'data-action="turnstile-spin-v1"' ), true );
check( 'widget loads the api.js script', (bool) strpos( $widget, 'challenges.cloudflare.com/turnstile/v0/api.js' ), true );

// The script prints once per page; a second widget prints only the div.
ob_start();
do_action( 'comment_form_after_fields' );
$widget2 = ob_get_clean();
check( 'second widget does not reprint the script', (bool) strpos( $widget2, 'api.js' ), false );
check( 'second widget still prints the div', (bool) strpos( $widget2, 'class="cf-turnstile"' ), true );

// 2) Login: a good token passes, a bad token and a missing token are rejected.
$_SERVER['REQUEST_METHOD'] = 'POST';
$_POST['log'] = 'admin';
$_POST['cf-turnstile-response'] = 'good-token';
ts_reply( array( 'ok' => true, 'success' => true ) );
$r = apply_filters( 'authenticate', null, 'admin', 'pw' );
check( 'login good token: not rejected', $r instanceof WP_Error, false );
check( 'login good token: verifier was called', $GLOBALS['ts_calls'], 1 );

ts_reply( array( 'ok' => true, 'success' => false, 'codes' => array( 'invalid-input-response' ) ) );
$r = apply_filters( 'authenticate', null, 'admin', 'pw' );
check( 'login bad token: rejected with WP_Error', $r instanceof WP_Error, true );

unset( $_POST['cf-turnstile-response'] );
ts_reply( array( 'ok' => true, 'success' => true ) ); // would pass, but the token is missing
$r = apply_filters( 'authenticate', null, 'admin', 'pw' );
check( 'login missing token: rejected', $r instanceof WP_Error, true );
check( 'login missing token: verifier not called', $GLOBALS['ts_calls'], 0 );

// A non-login request (no 'log' field) is never gated, so programmatic auth is untouched.
unset( $_POST['log'] );
$r = apply_filters( 'authenticate', 'passthrough-user', '', '' );
check( 'no-login-POST: passes through untouched', $r, 'passthrough-user' );
$_POST['log'] = 'admin';

// 3) Comment: a good token passes, a bad token is blocked with a 403.
$_POST['cf-turnstile-response'] = 'good-token';
ts_reply( array( 'ok' => true, 'success' => true ) );
$cd = array( 'comment_content' => 'hi', 'comment_type' => 'comment' );
$out = apply_filters( 'preprocess_comment', $cd );
check( 'comment good token: comment passes unchanged', $out, $cd );

ts_reply( array( 'ok' => true, 'success' => false ) );
$blocked = false; $code = null;
try { apply_filters( 'preprocess_comment', $cd ); } catch ( WpDieException $e ) { $blocked = true; $code = $e->args['response']; }
check( 'comment bad token: blocked', $blocked, true );
check( 'comment bad token: 403', $code, 403 );

// A pingback carries no widget and is never gated.
ts_reply( array( 'ok' => true, 'success' => false ) );
$ping = array( 'comment_type' => 'pingback' );
$out = apply_filters( 'preprocess_comment', $ping );
check( 'pingback: not gated', $out, $ping );

// 4) WooCommerce checkout: a good token places the order, a bad token fails it.
$GLOBALS['wc_notices'] = array();
$_POST['cf-turnstile-response'] = 'good-token';
ts_reply( array( 'ok' => true, 'success' => true ) );
do_action( 'woocommerce_checkout_process' );
check( 'checkout good token: no error notice', $GLOBALS['wc_notices'], array() );

ts_reply( array( 'ok' => true, 'success' => false ) );
do_action( 'woocommerce_checkout_process' );
check( 'checkout bad token: order failed with an error notice', count( $GLOBALS['wc_notices'] ), 1 );
check( 'checkout bad token: notice type is error', $GLOBALS['wc_notices'][0][1], 'error' );

// 5) Fail-closed on an outage, with an opt-in fail-open filter for infra errors only.
$_POST['cf-turnstile-response'] = 'some-token';
ts_reply( array( 'ok' => true, 'success' => false, 'error' => 'timeout' ) );
check( 'verifier outage: rejected by default (fail closed)', skyphusion_turnstile_verify( 'some-token' ), false );
$GLOBALS['hooks']['skyphusion_turnstile_failopen'][] = function ( $v, $reply ) { return true; };
check( 'verifier outage + fail-open filter: allowed', skyphusion_turnstile_verify( 'some-token' ), true );
// A genuinely bad token (no infra error) is never let through by fail-open.
ts_reply( array( 'ok' => true, 'success' => false ) );
check( 'bad token + fail-open filter: still rejected', skyphusion_turnstile_verify( 'some-token' ), false );

echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
exit( $fail ? 1 : 0 );
