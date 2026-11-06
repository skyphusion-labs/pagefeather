<?php
/**
 * TEST ONLY, never shipped: tests/http/http_bridge_check.py copies this into
 * the built tree's mu-plugins for a test run. An administrator-only REST route
 * that makes one wp_remote_request() and returns what WordPress got.
 */
add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			'skyphusion-test/v1',
			'/http',
			array(
				'methods'             => 'POST',
				'permission_callback' => function () {
					return current_user_can( 'manage_options' );
				},
				'callback'            => function ( WP_REST_Request $req ) {
					$p    = $req->get_json_params();
					// Akismet: verify_key() answers invalid when its API answered, failed when the
					// request did not get through. Its REST route answers invalid_key for both.
					if ( 'akismet_verify_key' === ( $p['url'] ?? '' ) ) {
						return array( 'akismet' => class_exists( 'Akismet' ) ? Akismet::verify_key( '000000000000' ) : 'not active' );
					}
					$args = array_merge( array( 'timeout' => 5 ), (array) ( $p['args'] ?? array() ) );
					if ( ! empty( $args['stream'] ) ) {
						require_once ABSPATH . 'wp-admin/includes/file.php'; // wp_tempnam(): not loaded for REST
						$args['filename'] = wp_tempnam( 'skyphusion-test' );
					}
					$url = ( 'home' === ( $p['url'] ?? '' ) ) ? home_url( '/?loopback-test=1' ) : $p['url'];
					$t0  = microtime( true );
					$r   = wp_remote_request( $url, $args );
					$ms  = (int) round( ( microtime( true ) - $t0 ) * 1000 );
					if ( is_wp_error( $r ) ) {
						return array( 'error' => true, 'code' => $r->get_error_code(), 'message' => $r->get_error_message(), 'ms' => $ms );
					}
					$headers = array();
					foreach ( wp_remote_retrieve_headers( $r ) as $k => $v ) {
						$headers[ strtolower( $k ) ] = $v;
					}
					$file = $r['filename'] ? @filesize( $r['filename'] ) : null;
					return array(
						'error'    => false,
						'status'   => wp_remote_retrieve_response_code( $r ),
						'message'  => wp_remote_retrieve_response_message( $r ),
						'headers'  => $headers,
						'body'     => substr( wp_remote_retrieve_body( $r ), 0, 4000 ),
						'body_len' => strlen( wp_remote_retrieve_body( $r ) ),
						'cookies'  => array_map( function ( $c ) { return $c->name; }, wp_remote_retrieve_cookies( $r ) ),
						'file_size' => $file,
						'ms'       => $ms,
					);
				},
			)
		);
	}
);
