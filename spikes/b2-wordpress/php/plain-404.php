<?php
/**
 * Plugin Name: An unknown path is a 404 under plain permalinks (#772)
 * Description: Stock WordPress under a PLAIN permalink structure never makes a 404 for an unknown path:
 *   WP::parse_request() sets error 404 only inside `if ( ! empty( $rewrite ) )` (class-wp.php at 7.1.4), and with
 *   plain permalinks there are no rewrite rules, so /no-such-thing is the front page with 200. On stock Apache that
 *   request never reaches WordPress: with plain permalinks there is no rewrite rule in .htaccess, the path is not a
 *   file, and Apache answers 404. (The common nginx config, try_files ... /index.php, hands it to WordPress and gets
 *   the front page, as we did.) Our router sends every path to index.php, so we answered as nginx; the ruling on
 *   #772 is Apache's answer: a 404, never a soft 404 (a 200 home page for a URL that does not exist).
 *
 *   So, under a plain structure, a request that index.php serves for a path other than the home path, index.php
 *   itself (and /index.php/...), gets WordPress's own error=404: the theme's 404 template with status 404. Its query
 *   string does not save it (on Apache the path decides). Canonical redirects are off for it: Apache never runs PHP
 *   there, so WordPress must not redirect it (a guessed permalink, or an added slash). Query-only URLs (/?p=1,
 *   /?feed=rss2, /?wc-ajax=...) and a pretty structure are untouched. Runs on parse_request at priority 20, after
 *   core's rest_api_loaded (10), which ends every REST request first (#773 maps /wp-json/ under plain at 5).
 */

if ( ! function_exists( 'skyphusion_plain_404_path' ) ) {
	/**
	 * Is this request an unknown path under plain permalinks?
	 *
	 * @param string $structure The permalink structure ('' is plain).
	 * @param string $uri       REQUEST_URI.
	 * @param string $script    SCRIPT_NAME (the PHP file serving the request).
	 * @param string $home_path The path of home_url('/'), with a trailing slash.
	 * @return bool
	 */
	function skyphusion_plain_404_path( $structure, $uri, $script, $home_path ) {
		if ( '' !== (string) $structure ) {
			return false;
		}
		$home = '/' . trim( (string) $home_path, '/' );
		$home = '/' === $home ? '/' : $home . '/';
		if ( $home . 'index.php' !== '/' . ltrim( (string) $script, '/' ) && 'index.php' !== basename( (string) $script ) ) {
			return false;
		}
		$path = (string) parse_url( (string) $uri, PHP_URL_PATH );
		if ( '' === $path || $path === $home || $path === rtrim( $home, '/' ) ) {
			return false;
		}
		$idx = $home . 'index.php';
		if ( $path === $idx || 0 === strpos( $path, $idx . '/' ) ) {
			return false;
		}
		return true;
	}
}

if ( ! function_exists( 'skyphusion_plain_404' ) ) {
	/** @param WP $wp The request. */
	function skyphusion_plain_404( $wp ) {
		$uri    = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : '';
		$script = isset( $_SERVER['SCRIPT_NAME'] ) ? (string) $_SERVER['SCRIPT_NAME'] : '';
		$home   = (string) wp_parse_url( home_url( '/' ), PHP_URL_PATH );
		if ( ! skyphusion_plain_404_path( get_option( 'permalink_structure' ), $uri, $script, $home ) ) {
			return;
		}
		$wp->query_vars = array( 'error' => '404' );
		add_filter( 'redirect_canonical', '__return_false' );
		add_filter( 'do_redirect_guess_404_permalink', '__return_false' );
	}
}
add_action( 'parse_request', 'skyphusion_plain_404', 20 );
