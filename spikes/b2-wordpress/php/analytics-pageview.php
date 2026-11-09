<?php
/**
 * Plugin Name: Privacy-friendly pageview analytics (b-dosql)
 * Description: Record one anonymized pageview per front-end request to a
 *   Cloudflare Analytics Engine dataset. Operator-facing site stats with no GA
 *   plugin, no cookie, no IP and no PII. The write is done by the Worker, not in
 *   PHP: on a front-end page load PHP gathers the request facts (host, path,
 *   status, country) and sends an analytics op to index.js through the
 *   post_message_to_js bridge; the Worker calls env.ANALYTICS.writeDataPoint. The
 *   dataset binding stays in the Worker and PHP never sees it, exactly as
 *   ai-alt-text.php never sees the AI binding.
 *
 *   What is recorded, and what is NOT: the host, the request PATH with the query
 *   string stripped, the HTTP status (200 or 404), and the coarse Cloudflare
 *   country code when present. There is no cookie read, no IP, no user agent, no
 *   query string, and no logged-in-user identity. The one field a dataset could
 *   abuse for per-visitor tracking is the index; it is set to the site HOST (site
 *   level), never anything per-visitor. This is server-side, operator-facing site
 *   stats, not a billing plane and not a public feed (the repo no-funnel rule).
 *
 *   b-dosql only, OPT-IN. index.js writes SKYPHUSION_ANALYTICS only when PHP_IN_DO
 *   and DB_IN_DO are on, the ANALYTICS binding is present, and WP_ANALYTICS is
 *   'on' (the analytics-engine descriptor sets it when the operator opts in).
 *   Default off: a site that never opts in records nothing.
 *
 * Fail safe. The page must always render. The op fires on shutdown, AFTER the
 * response, so it never delays the page; every step is wrapped, so a bridge error
 * or a missing binding records nothing and changes nothing. This plugin never
 * throws and never changes the request result.
 */

if ( ! defined( 'SKYPHUSION_ANALYTICS' ) || ! SKYPHUSION_ANALYTICS || ! function_exists( 'skyphusion_worker_call' ) ) {
	return;
}

/**
 * Captures one pageview during a front-end request and sends it after the
 * response. Captured at template_redirect (where the conditional tags are
 * authoritative) and flushed at shutdown (off the render path), the same
 * capture-now / send-at-shutdown shape as zone-cache-purge.php.
 */
final class Skyphusion_Pageview {
	/** @var array<string,string>|null The captured pageview, or null if none. */
	private static $point = null;

	/** @var bool The shutdown flush is registered. */
	private static $hooked = false;

	/**
	 * Record a front-end pageview for this request. Only a real human page load:
	 * a GET, not the admin, not AJAX / cron / REST, not a feed, robots.txt,
	 * favicon, a preview or the customizer. Those are machine or editor reads, not
	 * a reader viewing a page.
	 */
	public static function capture() {
		// Front-end only. template_redirect does not fire for the admin, wp-login
		// or REST, but guard anyway so the meaning of "pageview" is explicit.
		if ( is_admin() ) {
			return;
		}
		if ( function_exists( 'wp_doing_ajax' ) && wp_doing_ajax() ) {
			return;
		}
		if ( function_exists( 'wp_doing_cron' ) && wp_doing_cron() ) {
			return;
		}
		if ( defined( 'REST_REQUEST' ) && REST_REQUEST ) {
			return;
		}
		$method = isset( $_SERVER['REQUEST_METHOD'] ) ? strtoupper( (string) $_SERVER['REQUEST_METHOD'] ) : 'GET';
		if ( 'GET' !== $method ) {
			return; // a human reading a page is a GET; a POST is a form or an action
		}
		if ( ( function_exists( 'is_feed' ) && is_feed() )
			|| ( function_exists( 'is_trackback' ) && is_trackback() )
			|| ( function_exists( 'is_robots' ) && is_robots() )
			|| ( function_exists( 'is_favicon' ) && is_favicon() )
			|| ( function_exists( 'is_preview' ) && is_preview() )
			|| ( function_exists( 'is_customize_preview' ) && is_customize_preview() ) ) {
			return;
		}

		// Host: the request host, which is the site's own hostname. No port, lower
		// case, a conservative charset so a spoofed Host header cannot carry junk
		// into the dataset.
		$host = isset( $_SERVER['HTTP_HOST'] ) ? (string) wp_unslash( $_SERVER['HTTP_HOST'] ) : '';
		$host = strtolower( preg_replace( '/[^A-Za-z0-9.\-:]/', '', $host ) );
		$host = preg_replace( '/:\d+$/', '', $host ); // drop any :port

		// Path: the request path with the query string and fragment removed. The
		// query can carry a search term or a token, which privacy-friendly stats
		// must not store; index.js strips it again as belt and braces.
		$uri  = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : '/';
		$path = (string) wp_parse_url( $uri, PHP_URL_PATH );
		if ( '' === $path ) {
			$path = '/';
		}

		// Status: 404 for a not-found, else 200. template_redirect does not fire on
		// a fatal, so 5xx is not seen here; is_404() is authoritative at this hook.
		$status = ( function_exists( 'is_404' ) && is_404() ) ? '404' : '200';

		// Country: the coarse Cloudflare country code (two letters) when the edge
		// provides it. It is non-identifying geo, never an IP. Absent on a plain
		// workers.dev request, in which case it is left empty.
		$country = isset( $_SERVER['HTTP_CF_IPCOUNTRY'] ) ? strtoupper( preg_replace( '/[^A-Za-z]/', '', (string) $_SERVER['HTTP_CF_IPCOUNTRY'] ) ) : '';
		if ( strlen( $country ) > 8 ) {
			$country = substr( $country, 0, 8 );
		}

		self::$point = array(
			'host'    => $host,
			'path'    => $path,
			'status'  => $status,
			'country' => $country,
		);
		self::arm();
	}

	/** Register the shutdown flush exactly once. */
	private static function arm() {
		if ( ! self::$hooked ) {
			self::$hooked = true;
			add_action( 'shutdown', array( __CLASS__, 'flush' ), 0 );
		}
	}

	/**
	 * Send the captured pageview after the response. Never throws: an analytics
	 * write must not affect the request. The Worker returns { ok, recorded } or
	 * { ok, degraded }; PHP ignores the reply (fire and forget).
	 */
	public static function flush() {
		try {
			if ( null === self::$point ) {
				return;
			}
			$point       = self::$point;
			self::$point = null;
			skyphusion_worker_call( wp_json_encode( array( 'analytics' => $point ) ) );
		} catch ( Throwable $e ) {
			if ( function_exists( 'error_log' ) ) {
				error_log( 'analytics-pageview: ' . $e->getMessage() );
			}
		}
	}
}

add_action( 'template_redirect', array( 'Skyphusion_Pageview', 'capture' ), 99 );
