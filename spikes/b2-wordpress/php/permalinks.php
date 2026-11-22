<?php
/**
 * Plugin Name: Permalinks as stock WordPress chooses them (#760)
 * Description: Two parity fixes for the permalink structure.
 *
 *   1. Install. wp_install() calls wp_install_maybe_enable_pretty_permalinks(), which sets
 *      /%year%/%monthnum%/%day%/%postname%/ and keeps it only if a loopback wp_remote_get() of the
 *      hello-world post answers with the site's X-Pingback header. Our HTTP bridge refuses every
 *      request to the site's own host (index.js httpRefusal: the PHP object runs one request at a
 *      time, so a loopback would wait on itself). So the probe always failed, and every install
 *      kept PLAIN permalinks, where stock on a host with rewrites keeps the day-and-name structure.
 *      Our router sends every path to WordPress, which is the "rewrites work" case, and the post
 *      does serve with X-Pingback (measured on #760). So on the wp_install action, which fires
 *      after the probe for both /_install and the browser installer (wp-admin/install.php), this
 *      sets the structure the probe would have kept, ONLY when the structure is still empty. A
 *      later choice by the owner, plain included, is never touched: this runs at install only.
 *
 *   2. The REST API at its canonical path under a plain structure. Stock routes /wp-json/<x> to
 *      rest_route=/<x> through a rewrite rule (^wp-json/(.*)?), which exists only with pretty
 *      permalinks. Under plain, our /wp-json/ answered the home page with 200 and /wp-json/<route>
 *      a 301. On parse_request, before core's rest_api_loaded (priority 10), this sets the same
 *      query var the rule would. The REST API is then reachable at /wp-json/ whatever the owner
 *      picks; ?rest_route= keeps working. With pretty permalinks the rewrite rule already did it,
 *      and this does nothing.
 */

// #834: the rules version. Raise it when the stored rewrite rules must be rebuilt on every existing site.
// 1: the rules from before #834 had no /category/ or /tag/ archive (an install outside wp-admin, below).
if ( ! defined( 'SKYPHUSION_REWRITE_RULES_VERSION' ) ) {
	define( 'SKYPHUSION_REWRITE_RULES_VERSION', 1 );
}

if ( ! function_exists( 'skyphusion_permalinks_on_install' ) ) {
	/** The structure stock's install probe would have kept on a host with working rewrites. */
	function skyphusion_permalinks_on_install() {
		if ( '' !== (string) get_option( 'permalink_structure' ) ) {
			return;
		}
		global $wp_rewrite;
		$wp_rewrite->set_permalink_structure( '/%year%/%monthnum%/%day%/%postname%/' );
		// /_install runs wp_install outside wp-admin. There, category and post_tag registered at init with NO
		// rewrite rules (WP_Taxonomy adds them only under is_admin() or a permalink structure, and the structure
		// was empty then), so this flush stored rules with no /category/ or /tag/ archive: /?cat=1 redirected to
		// /category/uncategorized/, which answered 404 (opcache.sh's e2e, 2026-11-16). Stock's installer runs in
		// wp-admin, so its flush has them. Register the core taxonomies again (core does the same on change_locale)
		// now that the structure is set, then flush.
		create_initial_taxonomies();
		// Soft: the rules go to the database; there is no .htaccess to write.
		flush_rewrite_rules( false );
		update_option( 'skyphusion_rewrite_rules_version', SKYPHUSION_REWRITE_RULES_VERSION, true );
	}
}
add_action( 'wp_install', 'skyphusion_permalinks_on_install' );

// #834: the one-time repair. A site installed since #773 outside wp-admin stored rules with no /category/ or /tag/
// archive, and site update does not reinstall. On wp_loaded every taxonomy (core and plugins) is registered with the
// site's structure, so a soft flush here stores complete rules. Once per version: the option is autoloaded, so the
// check costs no query on later requests.
if ( ! function_exists( 'skyphusion_permalinks_repair' ) ) {
	function skyphusion_permalinks_repair() {
		if ( (int) get_option( 'skyphusion_rewrite_rules_version', 0 ) >= SKYPHUSION_REWRITE_RULES_VERSION ) {
			return;
		}
		flush_rewrite_rules( false );
		update_option( 'skyphusion_rewrite_rules_version', SKYPHUSION_REWRITE_RULES_VERSION, true );
	}
}
add_action( 'wp_loaded', 'skyphusion_permalinks_repair' );

if ( ! function_exists( 'skyphusion_permalinks_rest_route' ) ) {
	/**
	 * /wp-json/<x> under a plain structure: rest_route=/<x>, as stock's rewrite rule does.
	 *
	 * @param WP $wp The request.
	 */
	function skyphusion_permalinks_rest_route( $wp ) {
		if ( '' !== (string) get_option( 'permalink_structure' ) || ! empty( $wp->query_vars['rest_route'] ) ) {
			return;
		}
		$uri  = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_unslash( $_SERVER['REQUEST_URI'] ) : '';
		$path = (string) wp_parse_url( $uri, PHP_URL_PATH );
		$home = (string) wp_parse_url( home_url( '/' ), PHP_URL_PATH );
		$base = rtrim( $home, '/' ) . '/' . rest_get_url_prefix();
		if ( $path !== $base && 0 !== strpos( $path, $base . '/' ) ) {
			return;
		}
		$wp->query_vars['rest_route'] = '/' . ltrim( (string) substr( $path, strlen( $base ) ), '/' );
	}
}
add_action( 'parse_request', 'skyphusion_permalinks_rest_route', 5 );

// #1345: URL rewriting IS available. The engine's request handler sends every path that is not a file to index.php
// (its file-not-found action; php-self.mjs), as nginx's try_files does, in the Worker and in the object alike. Core
// decides got_url_rewrite() from SERVER_SOFTWARE (Apache with mod_rewrite, nginx, Caddy, IIS 7), which php-wasm does
// not set, so it was false: options-permalink.php then offers every structure with an /index.php prefix, and its
// "Post name" radio saved /index.php/%postname%/. Under that structure an all-digits slug misses
// wp_unique_post_slug()'s year guard (%postname% is not first), so /index.php/<id>/ ran as a year archive and answered
// 404 where stock (Apache, /%postname%/) gives the slug "<id>-2" and serves the post. got_mod_rewrite() stays false:
// no .htaccess is written here.
add_filter( 'got_url_rewrite', '__return_true' );
