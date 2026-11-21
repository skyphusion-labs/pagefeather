<?php
/**
 * Plugin Name: A PHP fatal or a 500 wp_die reaches the Worker as one line (#1153)
 * Description: WordPress answered 500 on themes.php (cf759hw) with no engine line, so the cause could not be read. On a
 *   fatal (error_get_last at shutdown: E_ERROR and its kin, an uncaught exception among them) or a wp_die that answers
 *   500, this sends the Worker the type, the message with addresses and URLs scrubbed (at most 300 characters), the file
 *   below /wordpress, the line, and the request method and path (no query: a nonce or a key never leaves). The Worker
 *   logs it as php-fatal. A wp_die whose response is null or 200 is a normal exit (wp_send_json), not a fatal (#1220).
 *   A wp_die with no response key uses the HTTP status the request already has. Only a 5xx status is a fatal.
 *   It changes no answer. Always on: it costs nothing unless a request dies.
 */

// A constant guard, not function_exists: PHP declares this file's functions before its first line runs.
if ( ! function_exists( 'post_message_to_js' ) || defined( 'SKYPHUSION_PHP_FATAL_LINE' ) ) {
	return;
}
define( 'SKYPHUSION_PHP_FATAL_LINE', true );

/** The message with every address and URL taken out, at most 300 characters. */
function skyphusion_php_fatal_scrub( $text ) {
	$t = preg_replace( '#https?://\S+#i', '[url]', (string) $text );
	$t = preg_replace( '/[^\s@<>"\'(),;:]+@[^\s@<>"\'(),;:]+/', '[address]', (string) $t );
	return substr( (string) $t, 0, 300 );
}

/**
 * Send one fatal (or one 500 wp_die) to the Worker. $err: error_get_last()'s shape, or
 * array( 'type' => 'wp_die', 'message' => ..., 'status' => 500 ).
 */
function skyphusion_php_fatal_report( $err ) {
	if ( ! is_array( $err ) || ! isset( $err['type'] ) ) {
		return;
	}
	$fatal = array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR );
	if ( 'wp_die' !== $err['type'] && ! in_array( $err['type'], $fatal, true ) ) {
		return;
	}
	$uri  = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '';
	$path = (string) parse_url( $uri, PHP_URL_PATH );
	$file = isset( $err['file'] ) ? (string) $err['file'] : '';
	$file = preg_replace( '#^.*?/wordpress/#', '', $file );
	$line = array(
		'type'   => $err['type'],
		'msg'    => skyphusion_php_fatal_scrub( isset( $err['message'] ) ? $err['message'] : '' ),
		'file'   => substr( $file, 0, 160 ),
		'line'   => isset( $err['line'] ) ? (int) $err['line'] : 0,
		'method' => isset( $_SERVER['REQUEST_METHOD'] ) ? substr( (string) $_SERVER['REQUEST_METHOD'], 0, 10 ) : '',
		'path'   => substr( $path, 0, 160 ),
	);
	if ( isset( $err['status'] ) ) {
		$line['status'] = (int) $err['status'];
	}
	post_message_to_js( json_encode( array( 'phpFatal' => $line ) ) );
}

/**
 * Log one wp_die when $status is a 5xx code. Null and every other status are normal exits (#1220).
 */
function skyphusion_php_fatal_die_report( $message, $status ) {
	if ( null === $status ) {
		return;
	}
	$code = (int) $status;
	if ( $code < 500 || $code > 599 ) {
		return;
	}
	$text = is_object( $message ) && method_exists( $message, 'get_error_message' ) ? $message->get_error_message() : ( is_string( $message ) ? $message : '' );
	skyphusion_php_fatal_report( array( 'type' => 'wp_die', 'message' => skyphusion_php_fatal_strip( $text ), 'status' => $code ) );
}

/**
 * A wp_die with no response key waits until the handler has set the HTTP status.
 * http_response_code() is false when nothing has set one. That answer is 200, not 500.
 * The real handler sets the status, then it calls die(), so shutdown runs this too.
 */
function skyphusion_php_fatal_die_pending_flush() {
	if ( ! isset( $GLOBALS['skyphusion_php_fatal_die_pending'] ) || ! is_array( $GLOBALS['skyphusion_php_fatal_die_pending'] ) ) {
		return;
	}
	$pending = $GLOBALS['skyphusion_php_fatal_die_pending'];
	$GLOBALS['skyphusion_php_fatal_die_pending'] = null;
	$code = function_exists( 'http_response_code' ) ? http_response_code() : false;
	$status = ( false === $code ) ? 200 : $code;
	skyphusion_php_fatal_die_report( $pending['message'], $status );
}

register_shutdown_function(
	static function () {
		skyphusion_php_fatal_die_pending_flush();
		skyphusion_php_fatal_report( error_get_last() );
	}
);

// A wp_die that answers 5xx (WordPress can fail a request without a PHP fatal). The original handler still runs.
// #1220: wp_send_json() ends with wp_die( '', '', array( 'response' => null ) ). null and 200 are normal exits.
// No response key is not a 500. Read the status the handler set (Ajax sets 200, the default handler sets 500).
foreach ( array( 'wp_die_handler', 'wp_die_ajax_handler', 'wp_die_json_handler' ) as $skyphusion_die_filter ) {
	add_filter(
		$skyphusion_die_filter,
		static function ( $handler ) {
			return static function ( $message, $title = '', $args = array() ) use ( $handler ) {
				if ( is_array( $args ) && array_key_exists( 'response', $args ) ) {
					if ( null !== $args['response'] ) {
						skyphusion_php_fatal_die_report( $message, $args['response'] );
					}
				} else {
					$GLOBALS['skyphusion_php_fatal_die_pending'] = array( 'message' => $message );
				}
				$result = call_user_func( $handler, $message, $title, $args );
				skyphusion_php_fatal_die_pending_flush();
				return $result;
			};
		},
		PHP_INT_MAX
	);
}
unset( $skyphusion_die_filter );

/** Tags out of a wp_die message (it is HTML), without depending on WordPress being fully loaded. */
function skyphusion_php_fatal_strip( $text ) {
	return trim( preg_replace( '/\s+/', ' ', strip_tags( (string) $text ) ) );
}
