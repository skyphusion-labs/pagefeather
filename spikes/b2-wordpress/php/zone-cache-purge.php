<?php
/**
 * Plugin Name: Zone cache purge on publish (b-dosql)
 * Description: Purge the Cloudflare ZONE edge cache (deploy/zone/) by URL when
 *   content changes, so an editor never sees up to edge_ttl (3600 s) of stale
 *   HTML. The zone lever caches anonymous HTML at the Cloudflare edge in front of
 *   the Worker; nothing else purges it on publish. This completes CR #18 (#205).
 *
 *   This is the ZONE cache, not the Worker page cache. edge-cache.php purges the
 *   Worker's own Cache API (Pages.purge(['wp-pages'])); this purges the zone edge
 *   through the Cloudflare cache-purge API. The two caches and the two purge
 *   mechanisms are separate, so both plugins can run on one site.
 *
 *   The Cloudflare Cache Purge token stays in the Worker. This plugin collects
 *   the affected URLs during a request and hands them to index.js (purgeZone op)
 *   once, after the request; the Worker calls POST /zones/{zone}/purge_cache with
 *   the scoped PURGE_TOKEN. PHP never sees the token, exactly as ai-alt-text.php
 *   never sees the AI binding.
 *
 *   Gated: SKYPHUSION_CACHE_PURGE, written by index.js only when PHP_IN_DO and
 *   DB_IN_DO are on and the PURGE_TOKEN and PURGE_ZONE bindings are both present
 *   (CACHE_PURGE=off turns it off). Fail safe: with the gate off there is no
 *   purge, and a purge that errors never affects the request. The zone edge_ttl
 *   bounds staleness if a purge is ever missed.
 *
 *   Purge by URL is on Free (cache-tag purge is Enterprise only), so this sends a
 *   URL list. It batches every URL a request produces into ONE purge call at
 *   shutdown, deduped (the proven cf-images-editor.php shutdown-flush pattern); a
 *   theme or site-wide change purges the whole zone instead.
 */

if ( ! defined( 'SKYPHUSION_CACHE_PURGE' ) || ! SKYPHUSION_CACHE_PURGE || ! function_exists( 'skyphusion_worker_call' ) ) {
	return;
}

/**
 * Collects the URLs a request changes and sends one purge at shutdown.
 */
final class Skyphusion_Zone_Purge {
	/** @var array<string,true> URLs to purge this request, as a set. */
	private static $urls = array();

	/** @var bool Purge the whole zone (a theme or site-wide change). */
	private static $everything = false;

	/** @var bool The shutdown flush is registered. */
	private static $hooked = false;

	/** Queue the whole zone. */
	public static function all() {
		self::$everything = true;
		self::arm();
	}

	/**
	 * Queue one URL. Absolute http(s) only; the Worker and Cloudflare both
	 * require a full URL for purge by URL.
	 *
	 * @param string $url The absolute URL to purge.
	 */
	public static function url( $url ) {
		if ( is_string( $url ) && preg_match( '#^https?://#i', $url ) ) {
			self::$urls[ $url ] = true;
			self::arm();
		}
	}

	/**
	 * The permalink, the home page, the main feed and the post comments feed for
	 * a post. These are the anonymous pages the zone cache can hold that a change
	 * to this post affects. Archive pages (category, tag, date, author) also list
	 * the post; purging every archive on each edit is heavy, so they are left to
	 * the edge_ttl (the same trade-off the issue describes).
	 *
	 * @param int $post_id The post ID.
	 */
	public static function post_urls( $post_id ) {
		$post_id = (int) $post_id;
		$link    = get_permalink( $post_id );
		if ( $link ) {
			self::url( $link );
		}
		self::url( home_url( '/' ) );
		$feed = get_feed_link();
		if ( $feed ) {
			self::url( $feed );
		}
		$cfeed = get_post_comments_feed_link( $post_id );
		if ( $cfeed ) {
			self::url( $cfeed );
		}
	}

	/** Register the shutdown flush exactly once, the first time anything queues. */
	private static function arm() {
		if ( ! self::$hooked ) {
			self::$hooked = true;
			// Late, so a purge covers everything the request did. flush() is also
			// safe to call more than once.
			add_action( 'shutdown', array( __CLASS__, 'flush' ), 99 );
		}
	}

	/**
	 * One purge call for the whole request, after the response. Everything wins
	 * over a URL list. Never throws: a purge failure must not affect the request.
	 */
	public static function flush() {
		try {
			if ( self::$everything ) {
				$payload = array( 'purgeZone' => array( 'everything' => true ) );
			} elseif ( ! empty( self::$urls ) ) {
				$payload = array( 'purgeZone' => array( 'files' => array_keys( self::$urls ) ) );
			} else {
				return;
			}
			skyphusion_worker_call( wp_json_encode( $payload ) );
		} catch ( Throwable $e ) {
			if ( function_exists( 'error_log' ) ) {
				error_log( 'zone-cache-purge: ' . $e->getMessage() );
			}
		} finally {
			self::$urls       = array();
			self::$everything = false;
		}
	}
}

/*
 * A published post changing (newly published, edited while published, or
 * unpublished) is what a visitor sees on a cached page. transition_post_status
 * gives both the old and the new status, so it covers save_post AND trashing in
 * one hook: autosaves, revisions and auto-drafts never enter or leave 'publish',
 * and a status change that neither leaves nor enters 'publish' changes no
 * anonymous page. Public (viewable) post types only.
 */
add_action(
	'transition_post_status',
	function ( $new_status, $old_status, $post ) {
		if ( ! $post instanceof WP_Post ) {
			return;
		}
		if ( 'publish' !== $new_status && 'publish' !== $old_status ) {
			return;
		}
		if ( post_type_exists( $post->post_type ) && is_post_type_viewable( $post->post_type ) ) {
			Skyphusion_Zone_Purge::post_urls( $post->ID );
		}
	},
	10,
	3
);

/*
 * A new comment that is auto-approved changes the comment list on the post's
 * page. $approved is 1 (approved), 0 (held) or 'spam'; purge only on approved.
 */
add_action(
	'comment_post',
	function ( $comment_id, $approved ) {
		if ( 1 === $approved || '1' === $approved || 'approve' === $approved ) {
			$comment = get_comment( $comment_id );
			if ( $comment && $comment->comment_post_ID ) {
				Skyphusion_Zone_Purge::post_urls( (int) $comment->comment_post_ID );
			}
		}
	},
	10,
	2
);

/*
 * A later moderation change (approve, unapprove, spam, trash) also changes the
 * post's comment list. wp_set_comment_status fires this hook, so this one action
 * covers every status transition.
 */
add_action(
	'transition_comment_status',
	function ( $new_status, $old_status, $comment ) {
		if ( 'approved' !== $new_status && 'approved' !== $old_status ) {
			return;
		}
		if ( $comment && $comment->comment_post_ID ) {
			Skyphusion_Zone_Purge::post_urls( (int) $comment->comment_post_ID );
		}
	},
	10,
	3
);

/*
 * A theme switch, a customizer save or a menu change can alter every page's
 * markup, so purge the whole zone rather than guess which URLs changed.
 */
foreach ( array( 'switch_theme', 'customize_save_after', 'wp_update_nav_menu' ) as $skyphusion_zone_hook ) {
	add_action( $skyphusion_zone_hook, array( 'Skyphusion_Zone_Purge', 'all' ) );
}
