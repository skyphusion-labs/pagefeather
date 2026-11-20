<?php
/**
 * Plugin Name: REST plugin activate returns the fatal (#998)
 * Description: activate_plugin loads the plugin inside ob_start and defines WP_SANDBOX_SCRAPING.
 *   The fatal handler returns at once when that constant is set. A fatal in the hook then
 *   leaves a REST client an empty 500. On that path this prints a JSON error.
 *   It does not make a failing plugin work. Stock core fails the same plugin the same way.
 */

if ( ! function_exists( 'skyphusion_plugin_activate_fatal_types' ) ) {
	/** @return int[] Error types that kill the request. */
	function skyphusion_plugin_activate_fatal_types() {
		return array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR );
	}
}

if ( ! function_exists( 'skyphusion_plugin_activate_should_report' ) ) {
	/**
	 * A REST activation fatal is one we must put in the body.
	 *
	 * @param array|null $error   error_get_last().
	 * @param bool       $sandbox WP_SANDBOX_SCRAPING is set.
	 * @param bool       $rest    REST_REQUEST is set.
	 * @return bool
	 */
	function skyphusion_plugin_activate_should_report( $error, $sandbox, $rest ) {
		if ( ! $sandbox || ! $rest || ! is_array( $error ) || ! isset( $error['type'] ) ) {
			return false;
		}
		return in_array( $error['type'], skyphusion_plugin_activate_fatal_types(), true );
	}
}

if ( ! function_exists( 'skyphusion_plugin_activate_fatal_payload' ) ) {
	/**
	 * REST error object for one fatal.
	 *
	 * @param array $error error_get_last().
	 * @return array
	 */
	function skyphusion_plugin_activate_fatal_payload( $error ) {
		$msg = isset( $error['message'] ) ? (string) $error['message'] : '';
		$nl  = strpos( $msg, "\n" );
		if ( false !== $nl ) {
			$msg = substr( $msg, 0, $nl );
		}
		return array(
			'code'    => 'rest_plugin_activate_fatal',
			'message' => $msg,
			'data'    => array(
				'status' => 500,
				'file'   => isset( $error['file'] ) ? (string) $error['file'] : '',
				'line'   => isset( $error['line'] ) ? (int) $error['line'] : 0,
			),
		);
	}
}

if ( ! function_exists( 'skyphusion_plugin_activate_fatal_shutdown' ) ) {
	/** Replace an empty sandbox buffer with the fatal JSON. */
	function skyphusion_plugin_activate_fatal_shutdown() {
		$error   = error_get_last();
		$sandbox = defined( 'WP_SANDBOX_SCRAPING' ) && WP_SANDBOX_SCRAPING;
		$rest    = defined( 'REST_REQUEST' ) && REST_REQUEST;
		if ( ! skyphusion_plugin_activate_should_report( $error, $sandbox, $rest ) ) {
			return;
		}
		while ( ob_get_level() > 0 ) {
			ob_end_clean();
		}
		if ( ! headers_sent() ) {
			http_response_code( 500 );
			header( 'Content-Type: application/json; charset=UTF-8' );
		}
		echo json_encode( skyphusion_plugin_activate_fatal_payload( $error ) );
	}
}

if ( ! function_exists( 'skyphusion_plugin_activate_fatal_boot' ) ) {
	/** Register the shutdown once. */
	function skyphusion_plugin_activate_fatal_boot() {
		register_shutdown_function( 'skyphusion_plugin_activate_fatal_shutdown' );
	}
	skyphusion_plugin_activate_fatal_boot();
}
