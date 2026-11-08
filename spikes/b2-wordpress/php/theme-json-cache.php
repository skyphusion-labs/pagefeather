<?php
/**
 * theme.json data kept across requests (b-dosql, issue #49).
 *
 * A block theme rebuilds its theme.json derived data on every request: the
 * global stylesheet, the global settings, the SVG filters, the user custom CSS
 * and the theme's template-part metadata. Core keeps these in the 'theme_json'
 * cache group and marks that group NON-persistent (wp-includes/load.php), so it
 * is recomputed each request. On the b-dosql profile this is about 38% of a
 * home page's PHP time locally (#49). This keeps those values across requests,
 * safely.
 *
 * Why core marks it non-persistent, and how this stays correct:
 *   Core's own comment (wp-includes/global-styles-and-settings.php) says the
 *   data is kept fresh because plugins can modify it through the
 *   wp_theme_json_data_default / _theme / _blocks / _user filters with dynamic
 *   data (an option, the current user, the time). There is no event to
 *   invalidate on for such a filter. So:
 *     - The cache is keyed on a SALT, a fingerprint of every input core itself
 *       uses: the active theme and parent with their versions, the WordPress
 *       version, the locale, the active plugins, and a counter that changes on
 *       every write of the user global styles (and on a customizer save and a
 *       theme switch). A change of any input is a new salt, so the old values
 *       are never read again. Saving a global style changes the counter, so the
 *       next page computes fresh (tests/load/cache_coherence.py, the #44
 *       regression). The salt lives in the object cache's group salt
 *       (JS_Object_Cache::set_group_salt), applied to the whole 'theme_json'
 *       group; core writes exactly six keys to that group, all theme.json
 *       derived (measured against WordPress 7.1.x), so the whole-group salt is
 *       exact.
 *     - It FAILS SAFE. If a callback on one of the four wp_theme_json_data_*
 *       filters is not core's own (its source file is not in wp-includes or
 *       wp-admin), or cannot be identified, no salt is set and the group stays
 *       per request, exactly as core marks it. A plugin whose filter output
 *       depends on state the salt cannot see is therefore never cached.
 *
 * On only with the object cache across requests (JS_OBJECT_CACHE, one object is
 * the only writer) and with JS_THEME_JSON_CACHE (THEME_JSON_CACHE=off turns it
 * off). The salt is set at wp_loaded, after all plugins and the theme have
 * registered their filters, and before the front-end stylesheet or the editor
 * settings are built. Front-end pages carry X-Theme-JSON-Cache: salt:<8hex>,
 * bypass:<why> or off.
 */

if ( ! defined( 'JS_OBJECT_CACHE' ) || ! defined( 'JS_THEME_JSON_CACHE' ) ) {
	return;
}

class Skyphusion_Theme_JSON_Cache {
	/** The core cache group this salts. Core marks it non-persistent. */
	const GROUP = 'theme_json';
	/** Option: counts up on every write of the user global styles, a customizer save, and a theme switch. */
	const GLOBAL_STYLES_CHANGED = 'skyphusion_global_styles_changed';

	/** The four filters that change theme.json data. A non-core callback on any of them is unsafe. */
	const HOOKS = array( 'wp_theme_json_data_default', 'wp_theme_json_data_theme', 'wp_theme_json_data_blocks', 'wp_theme_json_data_user' );

	/** @var string This request's decision, for the X-Theme-JSON-Cache header. */
	public static $state = 'off';

	/** The source file of a callback, or null when it cannot be identified. (Mirrors the route cache, #56.) */
	public static function source( $cb ) {
		try {
			if ( is_string( $cb ) && false === strpos( $cb, '::' ) && function_exists( $cb ) ) {
				return ( new ReflectionFunction( $cb ) )->getFileName();
			}
			if ( $cb instanceof Closure ) {
				return ( new ReflectionFunction( $cb ) )->getFileName();
			}
			if ( is_string( $cb ) && false !== strpos( $cb, '::' ) ) {
				list( $class, $method ) = explode( '::', $cb, 2 );
				return ( new ReflectionMethod( $class, $method ) )->getFileName();
			}
			if ( is_array( $cb ) && 2 === count( $cb ) ) {
				return ( new ReflectionMethod( $cb[0], $cb[1] ) )->getFileName();
			}
		} catch ( ReflectionException $e ) {
			return null;
		}
		return null; // An invokable object or anything else: not identified.
	}

	/** Why theme.json must not be kept now, or null when it is safe. */
	public static function unsafe() {
		$core = array( wp_normalize_path( ABSPATH . WPINC ) . '/', wp_normalize_path( ABSPATH . 'wp-admin' ) . '/' );
		foreach ( self::HOOKS as $hook ) {
			if ( empty( $GLOBALS['wp_filter'][ $hook ] ) ) {
				continue;
			}
			foreach ( $GLOBALS['wp_filter'][ $hook ]->callbacks as $callbacks ) {
				foreach ( $callbacks as $c ) {
					$file = self::source( $c['function'] );
					if ( null === $file || false === $file ) {
						return 'unidentified:' . $hook;
					}
					$file = wp_normalize_path( $file );
					if ( 0 !== strpos( $file, $core[0] ) && 0 !== strpos( $file, $core[1] ) ) {
						return 'filter:' . $hook;
					}
				}
			}
		}
		return null;
	}

	/** A fingerprint of every input the six theme_json values are built from. */
	public static function salt() {
		$theme  = wp_get_theme();
		$parent = $theme->parent();
		$parts  = array(
			'tj1',
			get_stylesheet(),
			$theme->get( 'Version' ),
			get_template(),
			$parent ? $parent->get( 'Version' ) : '',
			$GLOBALS['wp_version'],
			determine_locale(),
			(array) get_option( 'active_plugins', array() ),
			get_option( self::GLOBAL_STYLES_CHANGED, '0' ),
		);
		return md5( serialize( $parts ) );
	}
}

// The global-styles counter. These writes go through WordPress in the one
// object, so the hooks see every change: a save, trash or delete of a user
// wp_global_styles post, a customizer save, and a theme switch or preview. It
// counts up, so it never repeats (a time would not do: the clock in the object
// moves only at I/O, so two writes in one request would read the same time).
$skyphusion_global_styles_changed = function () {
	update_option( Skyphusion_Theme_JSON_Cache::GLOBAL_STYLES_CHANGED, (string) ( (int) get_option( Skyphusion_Theme_JSON_Cache::GLOBAL_STYLES_CHANGED, '0' ) + 1 ), true );
};
foreach ( array( 'save_post_wp_global_styles', 'customize_save_after', 'switch_theme', 'start_previewing_theme' ) as $skyphusion_hook ) {
	add_action( $skyphusion_hook, $skyphusion_global_styles_changed );
}
add_action(
	'deleted_post',
	function ( $post_id, $post ) use ( $skyphusion_global_styles_changed ) {
		if ( $post && 'wp_global_styles' === $post->post_type ) {
			$skyphusion_global_styles_changed();
		}
	},
	10,
	2
);
add_action(
	'trashed_post',
	function ( $post_id ) use ( $skyphusion_global_styles_changed ) {
		if ( 'wp_global_styles' === get_post_type( $post_id ) ) {
			$skyphusion_global_styles_changed();
		}
	}
);

// Decide once, after all filters are registered and before the stylesheet or the
// editor settings are built. If safe, make the whole theme_json group persistent
// under the salt; if not, leave it per request, exactly as core marks it.
add_action(
	'wp_loaded',
	function () {
		$oc = isset( $GLOBALS['wp_object_cache'] ) ? $GLOBALS['wp_object_cache'] : null;
		if ( ! $oc || ! method_exists( $oc, 'set_group_salt' ) ) {
			return;
		}
		$why = Skyphusion_Theme_JSON_Cache::unsafe();
		if ( null !== $why ) {
			Skyphusion_Theme_JSON_Cache::$state = 'bypass:' . $why;
			$oc->set_group_salt( Skyphusion_Theme_JSON_Cache::GROUP, '' );
			return;
		}
		$salt = Skyphusion_Theme_JSON_Cache::salt();
		Skyphusion_Theme_JSON_Cache::$state = 'salt:' . substr( $salt, 0, 8 );
		$oc->set_group_salt( Skyphusion_Theme_JSON_Cache::GROUP, $salt );
	},
	0
);

// A diagnostic header on the front-end page (like x-php-object). Informational only.
add_action(
	'send_headers',
	function () {
		if ( ! headers_sent() ) {
			header( 'X-Theme-JSON-Cache: ' . Skyphusion_Theme_JSON_Cache::$state );
		}
	}
);
