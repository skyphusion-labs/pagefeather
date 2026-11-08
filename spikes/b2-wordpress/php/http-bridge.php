<?php
/**
 * Outbound HTTP for approach B (issue #26).
 *
 * PHP in WebAssembly has no sockets in a Worker or a Durable Object, so every
 * wp_remote_*() request failed. This mu-plugin answers pre_http_request: it
 * sends the request through post_message_to_js() to index.js (httpOp), which
 * makes it with fetch(), and returns the answer in the array core returns.
 * The design is WordPress Playground's (it routes WordPress HTTP through the
 * host's fetch); HostlessWP does the same in a Worker (runtime/src/http.js).
 * See docs/prior-art.md.
 *
 * Kept as core does it (WP_Http::request):
 * - The same checks before sending: reject_unsafe_urls (wp_http_validate_url),
 *   allowed protocols, a valid URL, and block_request(), so WP_HTTP_BLOCK_EXTERNAL
 *   and WP_ACCESSIBLE_HOSTS keep their meaning.
 * - timeout, redirection (the number of redirects to follow), limit_response_size,
 *   stream and filename, headers, cookies, user-agent and the body.
 * - http_api_debug and the http_response filter run on the answer.
 * Added:
 * - skyphusion_http_allowed (filter, default true): a site can refuse a request
 *   before it leaves. The Worker allowlists hosts (HTTP_ALLOW_HOSTS): unset uses
 *   the WordPress, WooCommerce and Gravatar hosts; an empty list denies every host.
 * - A request to the site's own host is refused by index.js: the PHP object runs
 *   one request at a time, so a request to itself would wait on itself.
 * Not covered: curl_*(), fsockopen() and http:// streams (file_get_contents of a
 * URL). Plugins that use those directly still have no network.
 * sslverify cannot be turned off: fetch() always verifies TLS.
 *
 * Runs at the highest priority, so a plugin that answers pre_http_request
 * itself (a mock, a cache) still answers first.
 */

if ( ! function_exists( 'post_message_to_js' ) || defined( 'SKYPHUSION_HTTP_BRIDGE_OFF' ) ) {
	return; // Not in the Worker or the PHP object (a Container has real sockets), or HTTP_BRIDGE=off.
}

add_filter(
	'pre_http_request',
	function ( $pre, $args, $url ) {
		if ( false !== $pre ) {
			return $pre;
		}
		$fail = function ( $code, $message ) use ( $args, $url ) {
			$error = new WP_Error( $code, $message );
			do_action( 'http_api_debug', $error, 'response', 'Skyphusion_Http_Bridge', $args, $url );
			return $error;
		};
		// The checks core makes before it sends (class-wp-http.php).
		if ( ! empty( $args['reject_unsafe_urls'] ) ) {
			$url = wp_http_validate_url( $url );
		}
		if ( $url ) {
			$url = wp_kses_bad_protocol( $url, array( 'http', 'https', 'ssl' ) );
		}
		$parsed = $url ? wp_parse_url( $url ) : false;
		if ( empty( $url ) || empty( $parsed['scheme'] ) ) {
			return $fail( 'http_request_failed', __( 'A valid URL was not provided.' ) );
		}
		if ( _wp_http_get_object()->block_request( $url ) ) {
			return $fail( 'http_request_not_executed', __( 'User has blocked requests through HTTP.' ) );
		}
		if ( ! apply_filters( 'skyphusion_http_allowed', true, $url, $args ) ) {
			return $fail( 'http_request_not_executed', 'Refused by the skyphusion_http_allowed filter.' );
		}

		// Headers, cookies, user agent and body, as WP_Http::request() makes them.
		$headers = $args['headers'];
		if ( ! is_array( $headers ) ) {
			$headers = WP_Http::processHeaders( (string) $headers )['headers'];
		}
		$lower = array_change_key_case( $headers );
		if ( empty( $lower['user-agent'] ) && ! empty( $args['user-agent'] ) ) {
			$headers['User-Agent'] = $args['user-agent'];
		}
		if ( ! empty( $args['cookies'] ) ) {
			$pairs = array();
			foreach ( $args['cookies'] as $name => $value ) {
				if ( $value instanceof WP_Http_Cookie ) {
					$pairs[] = $value->getHeaderValue();
				} else {
					$pairs[] = $name . '=' . $value;
				}
			}
			$headers['Cookie'] = implode( '; ', $pairs );
		}
		$method = strtoupper( $args['method'] ?: 'GET' );
		$body   = $args['body'];
		if ( is_array( $body ) || is_object( $body ) ) {
			$body = http_build_query( $body, '', '&' );
			if ( empty( $lower['content-type'] ) ) {
				$headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=' . get_option( 'blog_charset' );
			}
		}
		$out = array();
		foreach ( $headers as $name => $value ) {
			$out[ (string) $name ] = is_array( $value ) ? implode( ', ', $value ) : (string) $value;
		}

		$reply = json_decode(
			post_message_to_js(
				json_encode(
					array(
						'http' => array(
							'url'         => $url,
							'method'      => $method,
							'headers'     => (object) $out,
							'body'        => ( null === $body || '' === $body || in_array( $method, array( 'GET', 'HEAD' ), true ) ) ? null : base64_encode( (string) $body ),
							'timeout'     => (float) $args['timeout'],
							'redirection' => (int) $args['redirection'],
							'limit'       => empty( $args['limit_response_size'] ) ? 0 : (int) $args['limit_response_size'],
						),
					)
				)
			),
			true
		);
		if ( ! is_array( $reply ) || isset( $reply['error'] ) ) {
			return $fail( 'http_request_failed', is_array( $reply ) && isset( $reply['error'] ) ? $reply['error'] : 'No answer from the Worker.' );
		}

		$body = 'HEAD' === $method ? '' : base64_decode( $reply['body'] );
		$filename = null;
		if ( ! empty( $args['stream'] ) ) {
			$filename = $args['filename'] ? $args['filename'] : get_temp_dir() . basename( $url );
			if ( false === file_put_contents( $filename, $body ) ) {
				return $fail( 'http_request_failed', sprintf( __( 'Could not open handle for %s to %s.' ), 'fopen()', $filename ) );
			}
			$body = '';
		}
		$dict    = array();
		$cookies = array();
		foreach ( $reply['headers'] as $pair ) {
			list( $name, $value ) = $pair;
			$name = strtolower( $name );
			if ( isset( $dict[ $name ] ) ) {
				$dict[ $name ] = array_merge( (array) $dict[ $name ], array( $value ) );
			} else {
				$dict[ $name ] = $value;
			}
			if ( 'set-cookie' === $name ) {
				$cookies[] = new WP_Http_Cookie( $value, $url );
			}
		}
		$response = array(
			'headers'       => class_exists( 'WpOrg\Requests\Utility\CaseInsensitiveDictionary' ) ? new WpOrg\Requests\Utility\CaseInsensitiveDictionary( $dict ) : $dict,
			'body'          => $body,
			'response'      => array(
				'code'    => (int) $reply['status'],
				'message' => $reply['statusText'] ? $reply['statusText'] : get_status_header_desc( (int) $reply['status'] ),
			),
			'cookies'       => $cookies,
			'filename'      => $filename,
			'http_response' => null,
		);
		do_action( 'http_api_debug', $response, 'response', 'Skyphusion_Http_Bridge', $args, $url );
		return apply_filters( 'http_response', $response, $args, $url );
	},
	PHP_INT_MAX,
	3
);
