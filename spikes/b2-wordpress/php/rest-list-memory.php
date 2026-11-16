<?php
/**
 * REST post lists that would load more post content than a PHP object can hold (issue #728).
 *
 * WP_Query loads every row of a list, post_content included, before the REST layer trims the answer to _fields.
 * Measured (#728, 2026-11-16): each listed 512 KiB page costs about 1 MiB of wasm memory (the row as SQLite hands
 * it over, and the PHP string built from it), on the npm and the lean engine alike, so one per_page=100 list over
 * large pages takes the object past its memory limit and the site restarts for everyone on it.
 *
 * 1. A list that does not need the content does not load it. When every field a request names in _fields is a core
 *    field that never reads post_content (KEEP below), the query selects every column but post_content, which comes
 *    back as ''. The answer is identical, since none of those fields read it. Any other field (content, excerpt or
 *    their parts, a field a plugin registers, which might read it), no _fields at all, or _embed: the content loads
 *    as before. Such a query never caches its posts (cache_results off): a post without its content must never reach
 *    the object cache, which other requests read. Two more loads of the full rows are stopped too:
 *    - update_post_thumbnail_cache (get_items calls it for every type with thumbnails, pages too) primes the cache
 *      with EVERY listed post, one SELECT of whole rows, only to read their thumbnail ids. Measured: that one query
 *      was the whole cost (the same 177 MiB with the columns trimmed). The query is marked thumbnails_cached
 *      (posts_results), so it is skipped; featured_media, when asked, still reads the post meta WP_Query primed.
 *    - a permission check (check_read_permission, check_update_permission, then map_meta_cap) may load one full post
 *      (get_post); after each item is prepared its post cache entry is dropped (rest_prepare_<type>), so at most
 *      about one full row is alive at a time. A cache entry is only a cache: dropping it costs a later request a
 *      reload, never correctness.
 * 2. A list that needs the content and would load too much of it is refused, BEFORE its rows load: one cheap query
 *    takes the IDs of the requested page, a second one the SUM(LENGTH(post_content)) of those IDs, and over the
 *    budget the request answers rest_list_too_large (HTTP 400), naming the budget and what to ask instead. Never a
 *    capped or partial list: a client paging by X-WP-TotalPages would skip posts.
 *
 * The budget is 24 MiB of content (about 48 MiB of wasm), the filter pagefeather_rest_list_content_budget (bytes).
 */

class Skyphusion_Rest_List_Memory {
	const BUDGET = 25165824; // 24 MiB of post_content in one list
	const FLAG = 'pagefeather_no_content';
	// Core post fields that never read post_content (wp-includes/rest-api/endpoints/class-wp-rest-posts-controller.php).
	const KEEP = array( 'id', 'date', 'date_gmt', 'guid', 'modified', 'modified_gmt', 'slug', 'status', 'type', 'link', 'title', 'author', 'parent', 'menu_order', 'template', 'comment_status', 'ping_status', 'format', 'sticky', 'categories', 'tags', 'featured_media', 'meta', 'permalink_template', 'generated_slug', 'class_list', 'password', '_links' );
	private static $refused = null;
	private static $light = false; // this request's list loads no content (layer 1)

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register' ), 99 );
		add_filter( 'posts_fields', array( __CLASS__, 'fields' ), 10, 2 );
		add_filter( 'posts_results', array( __CLASS__, 'results' ), 10, 2 );
		add_filter( 'rest_request_after_callbacks', array( __CLASS__, 'answer' ), 10, 3 );
	}

	public static function register() {
		foreach ( get_post_types( array( 'show_in_rest' => true ), 'objects' ) as $type ) {
			add_filter( 'rest_' . $type->name . '_query', array( __CLASS__, 'query' ), 99, 2 );
			add_filter( 'rest_prepare_' . $type->name, array( __CLASS__, 'evict' ), 99, 2 );
		}
	}

	/** Does this request need post_content? Yes unless every _fields entry is a KEEP field. */
	public static function needs_content( $request ) {
		if ( ! empty( $request['_embed'] ) ) {
			return true;
		}
		$fields = isset( $request['_fields'] ) ? wp_parse_list( $request['_fields'] ) : array();
		if ( ! $fields ) {
			return true;
		}
		foreach ( $fields as $f ) {
			$top = strtok( (string) $f, '.' );
			if ( ! in_array( $top, self::KEEP, true ) ) {
				return true;
			}
		}
		return false;
	}

	public static function query( $args, $request ) {
		if ( ! self::needs_content( $request ) ) {
			$args[ self::FLAG ] = true;
			$args['cache_results'] = false;
			self::$light = true;
			return $args;
		}
		$budget = (int) apply_filters( 'pagefeather_rest_list_content_budget', self::BUDGET );
		if ( $budget <= 0 ) {
			return $args;
		}
		$probe = new WP_Query( array_merge( $args, array( 'fields' => 'ids', 'no_found_rows' => true, 'cache_results' => false, 'update_post_meta_cache' => false, 'update_post_term_cache' => false ) ) );
		$ids = array_map( 'intval', (array) $probe->posts );
		if ( ! $ids ) {
			return $args;
		}
		global $wpdb;
		$bytes = (int) $wpdb->get_var( "SELECT SUM(LENGTH(post_content)) FROM {$wpdb->posts} WHERE ID IN (" . implode( ',', $ids ) . ')' );
		if ( $bytes <= $budget ) {
			return $args;
		}
		$mib = function ( $b ) { return round( $b / 1048576, 1 ); };
		self::$refused = new WP_Error(
			'rest_list_too_large',
			sprintf( 'This list would load %s MiB of post content, over the %s MiB one request can hold on this site. Ask for fewer items (a smaller per_page) or only the fields you need (for example _fields=id,title).', $mib( $bytes ), $mib( $budget ) ),
			array( 'status' => 400, 'content_mib' => $mib( $bytes ), 'budget_mib' => $mib( $budget ), 'items' => count( $ids ) )
		);
		$args['post__in'] = array( 0 ); // the rows never load; the answer is the error (answer() below)
		return $args;
	}

	public static function fields( $fields, $query ) {
		if ( ! $query->get( self::FLAG ) ) {
			return $fields;
		}
		global $wpdb;
		$p = $wpdb->posts;
		if ( "{$p}.*" !== trim( $fields ) ) {
			return $fields; // another filter changed the columns: leave them as they are
		}
		$cols = array( 'ID', 'post_author', 'post_date', 'post_date_gmt', 'post_title', 'post_excerpt', 'post_status', 'comment_status', 'ping_status', 'post_password', 'post_name', 'to_ping', 'pinged', 'post_modified', 'post_modified_gmt', 'post_content_filtered', 'post_parent', 'guid', 'menu_order', 'post_type', 'post_mime_type', 'comment_count' );
		return implode( ', ', array_map( function ( $c ) use ( $p ) { return "{$p}.{$c}"; }, $cols ) ) . ", '' AS post_content";
	}

	/** Layer 1: the list's own posts are not primed again, whole, for their thumbnails (update_post_thumbnail_cache). */
	public static function results( $posts, $query ) {
		if ( $query->get( self::FLAG ) ) {
			$query->thumbnails_cached = true;
		}
		return $posts;
	}

	/** Layer 1: drop the full post the permission check loaded for this item, so the page never holds them all. */
	public static function evict( $response, $post ) {
		if ( self::$light && $post instanceof WP_Post ) {
			wp_cache_delete( $post->ID, 'posts' );
		}
		return $response;
	}

	public static function answer( $response, $handler, $request ) {
		self::$light = false;
		if ( null === self::$refused ) {
			return $response;
		}
		$e = self::$refused;
		self::$refused = null;
		return $e;
	}
}

Skyphusion_Rest_List_Memory::init();
