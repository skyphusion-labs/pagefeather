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

/**
 * wp_http_validate_url() without DNS (#430). Core resolves a host name with gethostbyname() and
 * refuses the URL when it does not resolve; PHP in WebAssembly has no DNS, so EVERY host failed and
 * every wp_safe_remote_*() request (download_url(): plugin and theme installs and updates) answered
 * "A valid URL was not provided". This makes core's other checks unchanged, in core's order:
 * http or https only, the URL unchanged by wp_kses_bad_protocol, a host, no user or password, no
 * :#?[] in the host, core's safe ports (http_allowed_safe_ports) unless it is the site's own host
 * and port. Without DNS it cannot see where a NAME points, so it refuses what it can see instead:
 * an IPv4 literal in core's private ranges plus link-local 169.254/16 (cloud metadata), and names
 * that are not public (localhost, *.localhost, *.local, *.internal, and any name with no dot),
 * each unless http_request_host_is_external says otherwise. The real gate stays the Worker's host
 * allowlist (HTTP_ALLOW_HOSTS, http-allow.mjs), and a Worker's fetch() never reaches a private network.
 */
function skyphusion_http_validate_url( $url ) {
	if ( ! is_string( $url ) || '' === $url || is_numeric( $url ) ) {
		return false;
	}
	$original_url = $url;
	$url          = wp_kses_bad_protocol( $url, array( 'http', 'https' ) );
	if ( ! $url || strtolower( $url ) !== strtolower( $original_url ) ) {
		return false;
	}
	$parsed_url = parse_url( $url );
	if ( ! $parsed_url || empty( $parsed_url['host'] ) ) {
		return false;
	}
	if ( isset( $parsed_url['user'] ) || isset( $parsed_url['pass'] ) ) {
		return false;
	}
	if ( false !== strpbrk( $parsed_url['host'], ':#?[]' ) ) {
		return false;
	}
	$parsed_home = parse_url( get_option( 'home' ) );
	$same_host   = isset( $parsed_home['host'] ) && strtolower( $parsed_home['host'] ) === strtolower( $parsed_url['host'] );
	$host        = strtolower( trim( $parsed_url['host'], '.' ) );
	if ( ! $same_host ) {
		$internal = false;
		if ( preg_match( '#^(([1-9]?\d|1\d\d|25[0-5]|2[0-4]\d)\.){3}([1-9]?\d|1\d\d|25[0-5]|2[0-4]\d)$#', $host ) ) {
			$parts    = array_map( 'intval', explode( '.', $host ) );
			$internal = 127 === $parts[0] || 10 === $parts[0] || 0 === $parts[0]
				|| ( 172 === $parts[0] && 16 <= $parts[1] && 31 >= $parts[1] )
				|| ( 192 === $parts[0] && 168 === $parts[1] )
				|| ( 169 === $parts[0] && 254 === $parts[1] );
		} else {
			$internal = false === strpos( $host, '.' ) || 'localhost' === $host
				|| preg_match( '#\.(localhost|local|internal)$#', $host );
		}
		if ( $internal && ! apply_filters( 'http_request_host_is_external', false, $host, $url ) ) {
			return false;
		}
	}
	if ( empty( $parsed_url['port'] ) ) {
		return $url;
	}
	$port          = $parsed_url['port'];
	$allowed_ports = apply_filters( 'http_allowed_safe_ports', array( 80, 443, 8080 ), $host, $url );
	if ( is_array( $allowed_ports ) && in_array( $port, $allowed_ports, true ) ) {
		return $url;
	}
	if ( $parsed_home && $same_host && isset( $parsed_home['port'] ) && $parsed_home['port'] === $port ) {
		return $url;
	}
	return false;
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
			$url = skyphusion_http_validate_url( $url ); // core's checks without DNS (#430)
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
