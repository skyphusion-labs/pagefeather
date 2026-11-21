<?php
/**
 * Plugin Name: Real host resolution for WordPress's URL safety check (#1156)
 * Description: Inside the engine gethostbyname() returns emscripten's SYNTHETIC addresses (172.29.x.x, its socket
 *   emulation's DNS), which are in 172.16.0.0/12, so wp_http_validate_url took every external host for a private one
 *   and refused it: media sideload and url-details answered 400 for cldup.com and even wordpress.org. Core asks the
 *   http_request_host_is_external filter for a private-looking address. When that address is the synthetic one, this
 *   asks the Worker (dns-public.mjs) to resolve the name for real; the host is external only when every address it
 *   resolves to is public, as stock WordPress decides. A real private address, or a literal IP, keeps core's answer.
 *   HTTP_ALLOW_HOSTS still decides which hosts the engine fetches at all.
 */

if ( ! function_exists( 'post_message_to_js' ) || defined( 'SKYPHUSION_HTTP_EXTERNAL_DNS' ) ) {
	return;
}
define( 'SKYPHUSION_HTTP_EXTERNAL_DNS', true );

add_filter(
	'http_request_host_is_external',
	static function ( $external, $host, $url = '' ) {
		if ( $external ) {
			return $external;
		}
		$host = strtolower( trim( (string) $host, '.' ) );
		if ( '' === $host || filter_var( $host, FILTER_VALIDATE_IP ) ) {
			return $external;
		}
		$resolve = defined( 'SKYPHUSION_DNS_RESOLVER' ) ? SKYPHUSION_DNS_RESOLVER : 'gethostbyname';
		$ip      = (string) call_user_func( $resolve, $host );
		if ( ! preg_match( '/^172\.29\.\d{1,3}\.\d{1,3}$/', $ip ) ) {
			return $external; // a real private address: core's refusal stands
		}
		return '1' === (string) post_message_to_js( json_encode( array( 'dnsPublic' => array( 'host' => $host ) ) ) );
	},
	10,
	3
);
