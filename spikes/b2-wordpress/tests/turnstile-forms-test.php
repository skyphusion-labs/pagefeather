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
	foreach ( array( 'all', 'master-off', 'login-off', 'woo-off', 'register-off', 'woo-register-off', 'lostpassword-off', 'route-exception', 'sitekey-empty' ) as $sc ) {
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
	public $errors = array();
	public function __construct( $code = '', $message = '' ) {
		$this->code    = $code;
		$this->message = $message;
		if ( '' !== $code ) {
			$this->errors[ $code ] = array( $message );
		}
	}
	public function add( $code, $message ) {
		$this->errors[ $code ][] = $message;
		if ( '' === (string) $this->code ) {
			$this->code    = $code;
			$this->message = $message;
		}
	}
	public function get_error_code() {
		return (string) $this->code;
	}
}
function is_wp_error( $thing ) {
	return $thing instanceof WP_Error;
}
class WpDieException extends Exception {
	public $args;
	public function __construct( $message, $title, $args ) { parent::__construct( $message ); $this->args = $args; }
}
function wp_die( $message = '', $title = '', $args = array() ) { throw new WpDieException( $message, $title, $args ); }

$GLOBALS['wc_notices'] = array();
function wc_add_notice( $text, $type = 'success' ) { $GLOBALS['wc_notices'][] = array( $text, $type ); }

define( 'ARRAY_A', 'ARRAY_A' );
define( 'WPMU_PLUGIN_URL', 'https://shop.example/wp-content/mu-plugins' );
function content_url( $p = '' ) { return 'https://shop.example/wp-content/' . $p; }

// A WP_REST_Request with only the two methods the Store API gate reads.
class Fake_REST_Request {
	private $method;
	private $params;
	public function __construct( $method, $params ) { $this->method = $method; $this->params = $params; }
	public function get_method() { return $this->method; }
	public function get_param( $k ) { return $this->params[ $k ] ?? null; }
}

$GLOBALS['store_api_registered'] = array();
function woocommerce_store_api_register_endpoint_data( $args ) { $GLOBALS['store_api_registered'][] = $args; }

// ---- The worker-call stub: returns whatever the current test queued. ----
$GLOBALS['ts_reply']  = '{"ok":true,"success":true}';
$GLOBALS['ts_calls']  = 0;
function skyphusion_worker_call( $json ) { $GLOBALS['ts_calls']++; return $GLOBALS['ts_reply']; }

// ---- Scenario defines, then load the plugin once. ----
define( 'SKYPHUSION_TURNSTILE_SITEKEY', 'sitekey-empty' === $scenario ? '' : '1x00000000000000000000AA' );
switch ( $scenario ) {
	case 'master-off':
		define( 'SKYPHUSION_TURNSTILE', false );
		break;
	case 'login-off':
		define( 'SKYPHUSION_TURNSTILE', true );
		define( 'SKYPHUSION_TURNSTILE_LOGIN', false );
		break;
	case 'woo-off':
		define( 'SKYPHUSION_TURNSTILE', true );
		define( 'SKYPHUSION_TURNSTILE_WOO', false );
		break;
	case 'register-off':
		define( 'SKYPHUSION_TURNSTILE', true );
		define( 'SKYPHUSION_TURNSTILE_REGISTER', false );
		break;
	case 'woo-register-off':
		define( 'SKYPHUSION_TURNSTILE', true );
		define( 'SKYPHUSION_TURNSTILE_WOO_REGISTER', false );
		break;
	case 'lostpassword-off':
		define( 'SKYPHUSION_TURNSTILE', true );
		define( 'SKYPHUSION_TURNSTILE_LOSTPASSWORD', false );
		break;
	case 'route-exception':
		define( 'SKYPHUSION_TURNSTILE', true );
		eval( 'namespace Automattic\WooCommerce\StoreApi\Exceptions; class RouteException extends \Exception { public $error_code; public function __construct( $c, $m, $s = 400 ) { parent::__construct( $m, $s ); $this->error_code = $c; } }' );
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

if ( 'sitekey-empty' === $scenario ) {
	$_SERVER['REQUEST_METHOD'] = 'POST';
	$_POST['log'] = 'admin';
	unset( $_POST['cf-turnstile-response'] );
	$GLOBALS['ts_calls'] = 0;
	$r = apply_filters( 'authenticate', 'the-user', 'admin', 'pw' );
	check( 'empty site key: login returns the user', $r, 'the-user' );
	check( 'empty site key: login does not call the verifier', $GLOBALS['ts_calls'], 0 );
	$GLOBALS['wc_notices'] = array();
	do_action( 'woocommerce_checkout_process' );
	check( 'empty site key: checkout adds no notice', $GLOBALS['wc_notices'], array() );
	check( 'empty site key: checkout does not call the verifier', $GLOBALS['ts_calls'], 0 );
	$lost = new WP_Error();
	do_action( 'lostpassword_post', $lost );
	check( 'empty site key: lost password adds no error', $lost->get_error_code(), '' );
	$cd = array( 'comment_content' => 'hi', 'comment_type' => 'comment' );
	check( 'empty site key: comment passes', apply_filters( 'preprocess_comment', $cd ), $cd );
	$store = 'passed';
	try {
		do_action( 'woocommerce_store_api_checkout_update_order_from_request', null, new Fake_REST_Request( 'POST', array() ) );
	} catch ( Exception $e ) {
		$store = 'threw';
	}
	check( 'empty site key: store api POST does not throw', $store, 'passed' );
	check( 'empty site key: store api does not call the verifier', $GLOBALS['ts_calls'], 0 );
	ob_start();
	do_action( 'woocommerce_checkout_after_order_review' );
	check( 'empty site key: classic box is empty', ob_get_clean(), '' );
	echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
	exit( $fail ? 1 : 0 );
}


if ( 'login-off' === $scenario ) {
	check( 'login off: authenticate not hooked', has_hook( 'authenticate' ), false );
	check( 'login off: login_form not hooked', has_hook( 'login_form' ), false );
	check( 'login off: My Account login form not hooked', has_hook( 'woocommerce_login_form' ), false );
	check( 'login off: My Account login gate not hooked', has_hook( 'woocommerce_process_login_errors' ), false );
	check( 'login off: comments still hooked', has_hook( 'preprocess_comment' ), true );
	check( 'login off: checkout still hooked', has_hook( 'woocommerce_checkout_process' ), true );
	check( 'login off: block checkout gate still hooked', has_hook( 'woocommerce_store_api_checkout_update_order_from_request' ), true );
	check( 'login off: WordPress registration still hooked', has_hook( 'registration_errors' ), true );
	check( 'login off: WooCommerce registration still hooked', has_hook( 'woocommerce_process_registration_errors' ), true );
	check( 'login off: lost password still hooked', has_hook( 'lostpassword_post' ), true );
	echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
	exit( $fail ? 1 : 0 );
}

if ( 'woo-off' === $scenario ) {
	check( 'woo off: classic checkout not hooked', has_hook( 'woocommerce_checkout_process' ), false );
	check( 'woo off: block widget not hooked', has_hook( 'render_block' ), false );
	check( 'woo off: classic widget box not hooked', has_hook( 'woocommerce_checkout_after_order_review' ), false );
	check( 'woo off: classic scripts not hooked', has_hook( 'woocommerce_after_checkout_form' ), false );
	check( 'woo off: store api gate not hooked', has_hook( 'woocommerce_store_api_checkout_update_order_from_request' ), false );
	check( 'woo off: extension data not registered', has_hook( 'woocommerce_blocks_loaded' ), false );
	check( 'woo off: login still hooked', has_hook( 'authenticate' ), true );
	check( 'woo off: My Account login still hooked', has_hook( 'woocommerce_login_form' ), true );
	check( 'woo off: WooCommerce registration still hooked', has_hook( 'woocommerce_register_form' ), true );
	check( 'woo off: lost password still hooked', has_hook( 'lostpassword_form' ), true );
	echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
	exit( $fail ? 1 : 0 );
}

if ( 'register-off' === $scenario ) {
	check( 'register off: register_form not hooked', has_hook( 'register_form' ), false );
	check( 'register off: registration_errors not hooked', has_hook( 'registration_errors' ), false );
	check( 'register off: login still hooked', has_hook( 'authenticate' ), true );
	check( 'register off: My Account login still hooked', has_hook( 'woocommerce_login_form' ), true );
	check( 'register off: WooCommerce registration still hooked', has_hook( 'woocommerce_process_registration_errors' ), true );
	check( 'register off: lost password still hooked', has_hook( 'lostpassword_post' ), true );
	$_SERVER['REQUEST_METHOD'] = 'POST';
	$_POST['user_login'] = 'ada';
	$_POST['user_email'] = 'ada@example.com';
	unset( $_POST['cf-turnstile-response'] );
	$out = apply_filters( 'registration_errors', new WP_Error(), 'ada', 'ada@example.com' );
	check( 'register off: a missing token is not a registration error', $out->get_error_code(), '' );
	$_POST['log'] = 'admin';
	$r = apply_filters( 'authenticate', null, 'admin', 'pw' );
	check( 'register off: wp-login missing token still rejected', $r instanceof WP_Error, true );
	echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
	exit( $fail ? 1 : 0 );
}

if ( 'woo-register-off' === $scenario ) {
	check( 'woo register off: WooCommerce registration form not hooked', has_hook( 'woocommerce_register_form' ), false );
	check( 'woo register off: WooCommerce registration gate not hooked', has_hook( 'woocommerce_process_registration_errors' ), false );
	check( 'woo register off: WordPress registration still hooked', has_hook( 'register_form' ), true );
	check( 'woo register off: login still hooked', has_hook( 'woocommerce_login_form' ), true );
	check( 'woo register off: checkout still hooked', has_hook( 'woocommerce_checkout_process' ), true );
	$_SERVER['REQUEST_METHOD'] = 'POST';
	$_POST['email'] = 'ada@example.com';
	$_POST['woocommerce-register-nonce'] = 'n';
	unset( $_POST['cf-turnstile-response'] );
	$out = apply_filters( 'woocommerce_process_registration_errors', new WP_Error(), '', '', 'ada@example.com' );
	check( 'woo register off: a missing token is not a registration error', $out->get_error_code(), '' );
	echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
	exit( $fail ? 1 : 0 );
}

if ( 'lostpassword-off' === $scenario ) {
	check( 'lost password off: WordPress form not hooked', has_hook( 'lostpassword_form' ), false );
	check( 'lost password off: WooCommerce form not hooked', has_hook( 'woocommerce_lostpassword_form' ), false );
	check( 'lost password off: lostpassword_post not hooked', has_hook( 'lostpassword_post' ), false );
	check( 'lost password off: login still hooked', has_hook( 'authenticate' ), true );
	check( 'lost password off: WordPress registration still hooked', has_hook( 'registration_errors' ), true );
	$_SERVER['REQUEST_METHOD'] = 'POST';
	$_POST['user_login'] = 'ada';
	unset( $_POST['cf-turnstile-response'] );
	$lost = new WP_Error();
	do_action( 'lostpassword_post', $lost );
	check( 'lost password off: a missing token is not an error', $lost->get_error_code(), '' );
	echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
	exit( $fail ? 1 : 0 );
}

if ( 'route-exception' === $scenario ) {
	// With the Store API exception class present (WooCommerce 6.4 and later), a failed token is a 400
	// Store API error with our code, which the block checkout shows as a notice.
	$req = new Fake_REST_Request( 'POST', array( 'extensions' => array( 'skyphusion-turnstile' => array( 'token' => 'bad' ) ) ) );
	ts_reply( array( 'ok' => true, 'success' => false ) );
	$caught = null;
	try { do_action( 'woocommerce_store_api_checkout_update_order_from_request', null, $req ); } catch ( Exception $e ) { $caught = $e; }
	check( 'route exception: thrown class', $caught ? get_class( $caught ) : null, 'Automattic\WooCommerce\StoreApi\Exceptions\RouteException' );
	check( 'route exception: error code', $caught ? $caught->error_code : null, 'skyphusion_turnstile_failed' );
	check( 'route exception: HTTP 400', $caught ? $caught->getCode() : null, 400 );
	// An outage is a 503 with its own code (#351); the Worker adds Retry-After.
	$GLOBALS['hooks']['skyphusion_turnstile_failopen'][] = function ( $v, $reply ) { return true; };
	ts_reply( array( 'ok' => true, 'success' => false, 'error' => 'timeout' ) );
	$req = new Fake_REST_Request( 'POST', array( 'extensions' => array( 'skyphusion-turnstile' => array( 'token' => 'good' ) ) ) );
	$caught = null;
	try { do_action( 'woocommerce_store_api_checkout_update_order_from_request', null, $req ); } catch ( Exception $e ) { $caught = $e; }
	check( 'route exception outage: error code', $caught ? $caught->error_code : null, 'skyphusion_turnstile_unavailable' );
	check( 'route exception outage: HTTP 503', $caught ? $caught->getCode() : null, 503 );
	// A request with no front answer (a Store API batch, #351) is a failed token: a clean 400.
	ts_reply( array( 'ok' => true, 'success' => false, 'codes' => array( 'not-preverified' ) ) );
	$caught = null;
	try { do_action( 'woocommerce_store_api_checkout_update_order_from_request', null, $req ); } catch ( Exception $e ) { $caught = $e; }
	check( 'route exception not-preverified: failed code', $caught ? $caught->error_code : null, 'skyphusion_turnstile_failed' );
	check( 'route exception not-preverified: HTTP 400, not 500 or 503', $caught ? $caught->getCode() : null, 400 );
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

// 5) Fail-closed on an outage (#351). The login and both checkouts ALWAYS fail closed, with
// their own outage message; only the comment form may opt into fail-open, and only for an outage.
$_POST['cf-turnstile-response'] = 'some-token';
$_POST['log'] = 'admin';
ts_reply( array( 'ok' => true, 'success' => false, 'error' => 'timeout' ) );
check( 'result: an outage is unavailable', skyphusion_turnstile_result( 'some-token' ), 'unavailable' );
check( 'verifier outage: rejected by default (fail closed)', skyphusion_turnstile_verify( 'some-token' ), false );
$cd = array( 'comment_content' => 'hi', 'comment_type' => 'comment' );
$blocked = false;
try { apply_filters( 'preprocess_comment', $cd ); } catch ( WpDieException $e ) { $blocked = true; }
check( 'comment outage, no filter: blocked', $blocked, true );
$GLOBALS['hooks']['skyphusion_turnstile_failopen'][] = function ( $v, $reply ) { return true; };
check( 'verify outage + filter, not allowed by the caller: still rejected', skyphusion_turnstile_verify( 'some-token' ), false );
check( 'verify outage + filter, allowed by the caller: passes', skyphusion_turnstile_verify( 'some-token', true ), true );
check( 'comment outage + fail-open filter: passes', apply_filters( 'preprocess_comment', $cd ), $cd );
$r = apply_filters( 'authenticate', null, 'admin', 'pw' );
check( 'login outage + fail-open filter: still rejected (fail closed)', $r instanceof WP_Error, true );
check( 'login outage: its own code', $r instanceof WP_Error ? $r->code : null, 'turnstile_unavailable' );
check( 'login outage: try-again message', $r instanceof WP_Error ? $r->message : null, 'We could not check the challenge just now. Please try again in a moment.' );
$GLOBALS['wc_notices'] = array();
do_action( 'woocommerce_checkout_process' );
check( 'classic checkout outage + fail-open filter: order failed', count( $GLOBALS['wc_notices'] ), 1 );
check( 'classic checkout outage: try-again notice', $GLOBALS['wc_notices'][0][0] ?? null, 'We could not check the challenge just now. Please try again in a moment.' );
// A reply that is not JSON (a broken bridge) is an outage too, never a pass.
$GLOBALS['ts_reply'] = 'not json';
check( 'result: a broken bridge reply is unavailable', skyphusion_turnstile_result( 'some-token' ), 'unavailable' );
// A classic checkout with no front answer (posted without wc-ajax, #351) gets the normal notice.
ts_reply( array( 'ok' => true, 'success' => false, 'codes' => array( 'not-preverified' ) ) );
$GLOBALS['wc_notices'] = array();
do_action( 'woocommerce_checkout_process' );
check( 'classic checkout not-preverified: the challenge notice, not the outage one', $GLOBALS['wc_notices'][0][0] ?? null, 'Please complete the challenge to place your order.' );
// A bad token (no infra error) is never let through by fail-open, on any form.
ts_reply( array( 'ok' => true, 'success' => false ) );
check( 'result: a bad token is failed', skyphusion_turnstile_result( 'some-token' ), 'failed' );
check( 'bad token + fail-open filter: still rejected', skyphusion_turnstile_verify( 'some-token', true ), false );
$r = apply_filters( 'authenticate', null, 'admin', 'pw' );
check( 'login bad token: the challenge code, not the outage one', $r instanceof WP_Error ? $r->code : null, 'turnstile_failed' );
unset( $GLOBALS['hooks']['skyphusion_turnstile_failopen'] );

// 6) Block checkout (issue #308). The widget follows the checkout block once; other blocks are untouched.
check( 'render_block hooked', has_hook( 'render_block' ), true );
check( 'store api gate hooked', has_hook( 'woocommerce_store_api_checkout_update_order_from_request' ), true );
$other = apply_filters( 'render_block', '<p>x</p>', array( 'blockName' => 'core/paragraph' ) );
check( 'render_block: a non-checkout block is unchanged', $other, '<p>x</p>' );
$html = apply_filters( 'render_block', '<div class="wp-block-woocommerce-checkout"></div>', array( 'blockName' => 'woocommerce/checkout' ) );
check( 'block widget: keeps the block markup first', 0 === strpos( $html, '<div class="wp-block-woocommerce-checkout"></div>' ), true );
check( 'block widget: prints the box the script looks for', (bool) strpos( $html, 'id="skyphusion-turnstile-block"' ), true );
check( 'block widget: config carries the public site key', (bool) strpos( $html, '"sitekey":"1x00000000000000000000AA"' ), true );
check( 'block widget: config carries the extension namespace', (bool) strpos( $html, '"namespace":"skyphusion-turnstile"' ), true );
check( 'block widget: config carries the Spin marker', (bool) strpos( $html, '"action":"turnstile-spin-v1"' ), true );
check( 'block widget: loads the static block script', (bool) strpos( $html, 'src="https://shop.example/wp-content/mu-plugins/turnstile-forms/block-checkout.js?ver=308.2"' ), true );
check( 'block widget: loads api.js in explicit mode with the onload callback', (bool) strpos( $html, 'api.js?render=explicit&amp;onload=skyphusionTurnstileBlockReady' ), true );
$p_cfg = strpos( $html, 'window.skyphusionTurnstileBlock =' );
$p_js  = strpos( $html, 'block-checkout.js' );
$p_api = strpos( $html, 'api.js?render=explicit' );
check( 'block widget: config, then block script, then api.js', $p_cfg < $p_js && $p_js < $p_api, true );
$again = apply_filters( 'render_block', '<div>second</div>', array( 'blockName' => 'woocommerce/checkout' ) );
check( 'block widget: a second checkout block gets no second widget', $again, '<div>second</div>' );

// The extension namespace is registered on the checkout endpoint once WooCommerce Blocks loads.
do_action( 'woocommerce_blocks_loaded' );
$reg = $GLOBALS['store_api_registered'][0] ?? array();
check( 'store api: registered on the checkout endpoint', $reg['endpoint'] ?? null, 'checkout' );
check( 'store api: registered under the namespace', $reg['namespace'] ?? null, 'skyphusion-turnstile' );
check( 'store api: schema has a token field', isset( call_user_func( $reg['schema_callback'] )['token'] ), true );

// The gate. A good token passes, a bad or missing token stops the POST, PUT and PATCH are not gated.
function ts_store( $method, $ext ) { return new Fake_REST_Request( $method, array( 'extensions' => $ext ) ); }
function ts_gate( $req ) {
	try {
		do_action( 'woocommerce_store_api_checkout_update_order_from_request', null, $req );
		return 'passed';
	} catch ( Exception $e ) {
		return get_class( $e ) . ':' . $e->getMessage();
	}
}
$good = array( 'skyphusion-turnstile' => array( 'token' => 'good-token' ) );
ts_reply( array( 'ok' => true, 'success' => true ) );
check( 'store api good token: order passes', ts_gate( ts_store( 'POST', $good ) ), 'passed' );
check( 'store api good token: verifier was called once', $GLOBALS['ts_calls'], 1 );
ts_reply( array( 'ok' => true, 'success' => false, 'codes' => array( 'invalid-input-response' ) ) );
check( 'store api bad token: order stopped (plain exception without RouteException)', ts_gate( ts_store( 'POST', $good ) ), 'Exception:Please complete the challenge to place your order.' );
ts_reply( array( 'ok' => true, 'success' => true ) ); // would pass, but no token is sent
check( 'store api no extensions: order stopped', ts_gate( ts_store( 'POST', null ) ), 'Exception:Please complete the challenge to place your order.' );
check( 'store api no extensions: verifier not called', $GLOBALS['ts_calls'], 0 );
check( 'store api other namespace only: order stopped', ts_gate( ts_store( 'POST', array( 'other' => array( 'token' => 'good-token' ) ) ) ), 'Exception:Please complete the challenge to place your order.' );
check( 'store api non-string token: order stopped', ts_gate( ts_store( 'POST', array( 'skyphusion-turnstile' => array( 'token' => array( 'x' ) ) ) ) ), 'Exception:Please complete the challenge to place your order.' );
check( 'store api empty token: order stopped', ts_gate( ts_store( 'POST', array( 'skyphusion-turnstile' => array( 'token' => '' ) ) ) ), 'Exception:Please complete the challenge to place your order.' );
ts_reply( array( 'ok' => true, 'success' => false ) );
check( 'store api PUT draft update: not gated', ts_gate( ts_store( 'PUT', null ) ), 'passed' );
check( 'store api PATCH draft update: not gated', ts_gate( ts_store( 'PATCH', null ) ), 'passed' );
check( 'store api PUT: verifier not called', $GLOBALS['ts_calls'], 0 );
ts_reply( array( 'ok' => true, 'success' => false, 'error' => 'timeout' ) );
check( 'store api verifier outage: stopped (fail closed)', ts_gate( ts_store( 'POST', $good ) ), 'Exception:We could not check the challenge just now. Please try again in a moment.' );
$GLOBALS['hooks']['skyphusion_turnstile_failopen'][] = function ( $v, $reply ) { return true; };
check( 'store api verifier outage + fail-open filter: still stopped (#351)', ts_gate( ts_store( 'POST', $good ) ), 'Exception:We could not check the challenge just now. Please try again in a moment.' );
unset( $GLOBALS['hooks']['skyphusion_turnstile_failopen'] );

// ---- Classic checkout widget (issue #400, #958). ----
// The box prints outside #order_review, so update_order_review does not replace it. It carries
// no script and no cf-turnstile class, and the scripts print once, after the form.
ob_start();
do_action( 'woocommerce_checkout_after_order_review' );
$box = ob_get_clean();
check( 'classic box: printed with its class', (bool) strpos( $box, 'class="skyphusion-turnstile-classic"' ), true );
check( 'classic box: carries the public site key', (bool) strpos( $box, 'data-sitekey="1x00000000000000000000AA"' ), true );
check( 'classic box: carries the Spin marker', (bool) strpos( $box, 'data-action="turnstile-spin-v1"' ), true );
check( 'classic box: no script in the box', strpos( $box, '<script' ), false );
check( 'classic box: not the implicit cf-turnstile class', strpos( $box, 'cf-turnstile' ), false );
ob_start();
do_action( 'woocommerce_checkout_after_order_review' );
$box2 = ob_get_clean();
check( 'classic box: printed again on a second full render', $box2, $box );
ob_start();
do_action( 'woocommerce_after_checkout_form' );
$cs = ob_get_clean();
check( 'classic scripts: config with the site key', (bool) strpos( $cs, 'window.skyphusionTurnstileClassic = {"sitekey":"1x00000000000000000000AA","action":"turnstile-spin-v1"}' ), true );
check( 'classic scripts: loads the static classic script', (bool) strpos( $cs, 'src="https://shop.example/wp-content/mu-plugins/turnstile-forms/classic-checkout.js?ver=400.2"' ), true );
check( 'classic scripts: api.js in explicit mode with the classic onload', (bool) strpos( $cs, 'api.js?render=explicit&amp;onload=skyphusionTurnstileClassicReady' ), true );
$c_cfg = strpos( $cs, 'skyphusionTurnstileClassic =' );
$c_js  = strpos( $cs, 'classic-checkout.js' );
$c_api = strpos( $cs, 'api.js' );
check( 'classic scripts: config, then the script, then api.js', $c_cfg < $c_js && $c_js < $c_api, true );
ob_start();
do_action( 'woocommerce_after_checkout_form' );
check( 'classic scripts: printed once per page', ob_get_clean(), '' );

// 7) My Account login, both registrations and both lost-password forms (#857).
// A missing token is refused, an outage is refused even when the comment form's
// fail-open filter is on, and a good token is checked and then allowed. On main
// none of these hooks exist, so a right password with no token is not challenged.
function ts_code( $errors ) {
	return is_wp_error( $errors ) ? $errors->get_error_code() : null;
}
function ts_widget( $hook ) {
	ob_start();
	do_action( $hook );
	return ob_get_clean();
}
$_SERVER['REQUEST_METHOD'] = 'POST';
unset( $_POST['log'], $_POST['cf-turnstile-response'] );
$GLOBALS['hooks']['skyphusion_turnstile_failopen'][] = function () { return true; };

$_POST['username'] = 'ada';
$_POST['password'] = 'secret';
$_POST['woocommerce-login-nonce'] = 'n';
$out = apply_filters( 'woocommerce_process_login_errors', new WP_Error(), 'ada', 'secret' );
check( 'account login missing token: rejected', ts_code( $out ), 'turnstile_failed' );
check( 'account login widget', false !== strpos( ts_widget( 'woocommerce_login_form' ), 'class="cf-turnstile"' ), true );
$_POST['cf-turnstile-response'] = 'good-token';
ts_reply( array( 'ok' => true, 'success' => true ) );
$out = apply_filters( 'woocommerce_process_login_errors', new WP_Error(), 'ada', 'secret' );
check( 'account login good token: not rejected', ts_code( $out ), '' );
check( 'account login good token: verifier was called', $GLOBALS['ts_calls'], 1 );
ts_reply( array( 'ok' => true, 'success' => false, 'error' => 'timeout' ) );
$out = apply_filters( 'woocommerce_process_login_errors', new WP_Error(), 'ada', 'secret' );
check( 'account login outage: still rejected (fail closed)', ts_code( $out ), 'turnstile_unavailable' );

unset( $_POST['username'], $_POST['password'], $_POST['woocommerce-login-nonce'], $_POST['cf-turnstile-response'] );
$_POST['email'] = 'ada@example.com';
$_POST['woocommerce-register-nonce'] = 'n';
$out = apply_filters( 'woocommerce_process_registration_errors', new WP_Error(), '', '', 'ada@example.com' );
check( 'WooCommerce registration missing token: rejected', ts_code( $out ), 'turnstile_failed' );
check( 'WooCommerce registration widget', false !== strpos( ts_widget( 'woocommerce_register_form' ), 'class="cf-turnstile"' ), true );
$_POST['cf-turnstile-response'] = 'good-token';
ts_reply( array( 'ok' => true, 'success' => true ) );
$out = apply_filters( 'woocommerce_process_registration_errors', new WP_Error(), '', '', 'ada@example.com' );
check( 'WooCommerce registration good token: not rejected', ts_code( $out ), '' );
check( 'WooCommerce registration good token: verifier was called', $GLOBALS['ts_calls'], 1 );
ts_reply( array( 'ok' => true, 'success' => false, 'error' => 'timeout' ) );
$out = apply_filters( 'woocommerce_process_registration_errors', new WP_Error(), '', '', 'ada@example.com' );
check( 'WooCommerce registration outage: still rejected (fail closed)', ts_code( $out ), 'turnstile_unavailable' );

unset( $_POST['email'], $_POST['woocommerce-register-nonce'], $_POST['cf-turnstile-response'] );
$_POST['user_login'] = 'ada';
$_POST['user_email'] = 'ada@example.com';
$out = apply_filters( 'registration_errors', new WP_Error(), 'ada', 'ada@example.com' );
check( 'WordPress registration missing token: rejected', ts_code( $out ), 'turnstile_failed' );
check( 'WordPress registration widget', false !== strpos( ts_widget( 'register_form' ), 'class="cf-turnstile"' ), true );
$_POST['cf-turnstile-response'] = 'good-token';
ts_reply( array( 'ok' => true, 'success' => true ) );
$out = apply_filters( 'registration_errors', new WP_Error(), 'ada', 'ada@example.com' );
check( 'WordPress registration good token: not rejected', ts_code( $out ), '' );
check( 'WordPress registration good token: verifier was called', $GLOBALS['ts_calls'], 1 );
ts_reply( array( 'ok' => true, 'success' => false, 'error' => 'timeout' ) );
$out = apply_filters( 'registration_errors', new WP_Error(), 'ada', 'ada@example.com' );
check( 'WordPress registration outage: still rejected (fail closed)', ts_code( $out ), 'turnstile_unavailable' );

unset( $_POST['user_login'], $_POST['user_email'], $_POST['cf-turnstile-response'] );
$_POST['user_login'] = 'ada';
$_POST['woocommerce-lost-password-nonce'] = 'n';
$lost = new WP_Error();
do_action( 'lostpassword_post', $lost );
check( 'lost password missing token: rejected', ts_code( $lost ), 'turnstile_failed' );
check( 'WordPress lost-password widget', false !== strpos( ts_widget( 'lostpassword_form' ), 'class="cf-turnstile"' ), true );
check( 'WooCommerce lost-password widget', false !== strpos( ts_widget( 'woocommerce_lostpassword_form' ), 'class="cf-turnstile"' ), true );
$_POST['cf-turnstile-response'] = 'good-token';
ts_reply( array( 'ok' => true, 'success' => true ) );
$lost = new WP_Error();
do_action( 'lostpassword_post', $lost );
check( 'lost password good token: not rejected', ts_code( $lost ), '' );
check( 'lost password good token: verifier was called', $GLOBALS['ts_calls'], 1 );
ts_reply( array( 'ok' => true, 'success' => false, 'error' => 'timeout' ) );
$lost = new WP_Error();
do_action( 'lostpassword_post', $lost );
check( 'lost password outage: still rejected (fail closed)', ts_code( $lost ), 'turnstile_unavailable' );
unset( $GLOBALS['hooks']['skyphusion_turnstile_failopen'] );

echo $fail ? "\n$fail FAILED\n" : "\nALL PASS\n";
exit( $fail ? 1 : 0 );
