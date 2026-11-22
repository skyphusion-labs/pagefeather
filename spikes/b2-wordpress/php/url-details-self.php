<?php
/**
 * url-details for the site's OWN URL, without an HTTP hop (#1157, option (d); Conrad's choice, 2026-11-22).
 *
 * The block editor's link preview asks GET /wp-block-editor/v1/url-details?url=... and core's controller
 * (WP_REST_URL_Details_Controller) fetches that URL with wp_safe_remote_get() and reads its <head>. In a Worker a
 * fetch of the site's own host cannot leave: Cloudflare refuses a same-zone fetch() without a service binding (error
 * 1042, workers.dev included), and this isolate's one PHP runtime is busy with the request that asks. With the
 * overflow pool off and no cached copy (#1326 tries the front page cache first), index.js refuses the request and marks
 * the refusal "self". url-details then answered 404 no_response, and the gb navigation specs lost the preview title.
 *
 * This is a documented Cloudflare workaround, kept narrow: the site's own host only, GET only, and only a request
 * that core's url-details controller sent (it is tagged through core's rest_url_details_http_request_args filter).
 * On that refusal the bridge (http-bridge.php) asks the skyphusion_http_self_refused filter, and this answers a 200
 * whose body is a minimal <head> built in-process from WordPress's own data. Core's controller then parses it, caches
 * it (its 1 h site transient) and applies rest_prepare_url_details, exactly as it does a fetched page.
 *
 * The head:
 * - <title>: core's document title (wp_get_document_title) for the post the URL names (url_to_postid), or for the
 *   front page: the same parts, document_title_separator, document_title_parts and document_title filters.
 * - the icon tags: wp_site_icon(), as the page prints them (core reads the first rel=icon).
 * - no description and no og:image: core prints neither, so stock answers them empty too.
 *
 * How it differs from stock (docs/guide/limits.md names each one):
 * - <head> output that a plugin or theme adds by reading the main query (an SEO plugin's description, og:image, or
 *   a pre_get_document_title or document_title_parts filter that checks is_singular()) is missing or different: the
 *   page is not rendered, and the main query is this REST request's.
 * - a paged URL (/page/2) has no "Page 2" part.
 * Refused, as before (404 no_response), never guessed:
 * - a URL that names no post or page (an archive, a term, an author, search, a custom route);
 * - a post an anonymous visitor cannot see (draft, private, trash): stock's anonymous fetch gets a 404 too;
 * - a CLASSIC theme without title-tag support (it prints its own <title>). A block theme prints core's title.
 * Every other request to the site's own URL (Site Health's loopback, the file editor's check, HTTPS detection, Action
 * Scheduler's async runner, a plugin calling its own REST route) stays refused on an uncached URL.
 */

if ( ! function_exists( 'post_message_to_js' ) || defined( 'SKYPHUSION_HTTP_BRIDGE_OFF' ) ) {
	return; // The bridge is off, so a self-fetch is a real fetch; nothing to answer here.
}

// The tag: only a request core's url-details controller made carries it.
add_filter(
	'rest_url_details_http_request_args',
	function ( $args ) {
		$args['skyphusion_url_details'] = true;
		return $args;
	},
	10,
	1
);

/**
 * The post (or 'front') a URL on this site names, or null.
 */
function skyphusion_url_details_self_target( $url ) {
	$home = wp_parse_url( home_url( '/' ) );
	$u    = wp_parse_url( $url );
	if ( ! $u || ! $home || empty( $u['host'] ) || strtolower( $u['host'] ) !== strtolower( $home['host'] ) ) {
		return null;
	}
	$path = rtrim( isset( $u['path'] ) ? $u['path'] : '/', '/' );
	if ( $path === rtrim( isset( $home['path'] ) ? $home['path'] : '/', '/' ) && empty( $u['query'] ) ) {
		return 'front';
	}
	$id = url_to_postid( $url );
	if ( ! $id ) {
		return null;
	}
	$post = get_post( $id );
	if ( ! $post || ! is_post_publicly_viewable( $post ) ) {
		return null;
	}
	if ( 'page' === get_option( 'show_on_front' ) && (int) get_option( 'page_on_front' ) === (int) $post->ID ) {
		return 'front';
	}
	return $post;
}

/**
 * Core's document title (wp_get_document_title) for the front page or one post, without the main query.
 */
function skyphusion_url_details_self_title( $target ) {
	if ( 'front' === $target ) {
		$title = array(
			'title'   => get_bloginfo( 'name', 'display' ),
			'tagline' => get_bloginfo( 'description', 'display' ),
		);
	} else {
		$title = array(
			'title' => apply_filters( 'single_post_title', $target->post_title, $target ),
			'site'  => get_bloginfo( 'name', 'display' ),
		);
	}
	$sep   = apply_filters( 'document_title_separator', '-' );
	$title = apply_filters( 'document_title_parts', $title );
	$title = implode( " $sep ", array_filter( $title ) );
	return apply_filters( 'document_title', $title );
}

add_filter(
	'skyphusion_http_self_refused',
	function ( $answer, $url, $args, $method ) {
		// A block theme prints core's document title whether or not it declares title-tag (block-template.php,
		// _block_template_render_title_tag); core adds no title-tag support for block themes. A classic theme without
		// title-tag prints its own <title>, so it is refused, never guessed (#1326 live proof, 2026-11-22).
		$core_title = current_theme_supports( 'title-tag' ) || ( function_exists( 'wp_is_block_theme' ) && wp_is_block_theme() );
		if ( null !== $answer || 'GET' !== $method || empty( $args['skyphusion_url_details'] ) || ! $core_title ) {
			return $answer;
		}
		$target = skyphusion_url_details_self_target( $url );
		if ( null === $target ) {
			return $answer;
		}
		ob_start();
		wp_site_icon();
		$icons = ob_get_clean();
		$charset = get_bloginfo( 'charset' );
		$body    = '<!DOCTYPE html><html><head><meta charset="' . esc_html( $charset ) . '" />' . "\n"
			. '<title>' . skyphusion_url_details_self_title( $target ) . '</title>' . "\n"
			. $icons
			. '</head><body></body></html>';
		return array(
			'headers'       => array(
				'content-type'   => 'text/html; charset=' . $charset,
				'x-pf-synthetic' => 'url-details-self',
			),
			'body'          => $body,
			'response'      => array(
				'code'    => 200,
				'message' => 'OK',
			),
			'cookies'       => array(),
			'filename'      => null,
			'http_response' => null,
		);
	},
	10,
	4
);
