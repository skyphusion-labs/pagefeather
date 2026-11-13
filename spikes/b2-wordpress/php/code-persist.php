<?php
/**
 * Plugin Name: Installed code persists
 * Description: A plugin or theme installed, updated or deleted from wp-admin stays that way (issue #407).
 *
 * PHP's files on b-dosql live in memory and are rebuilt at every runtime boot, so an install used to
 * vanish. This mu-plugin hands each install, update and delete to the Worker (index.js codeOp), which
 * stores the directory as one zip in the site's own R2 bucket, indexed in the site's own database,
 * and mounts it again at every boot (code-store.mjs). Off unless the Worker defines
 * SKYPHUSION_CODE_PERSIST (CODE_PERSIST=on).
 *
 * - An install or update is stored inside upgrader_post_install. If the store fails (the code budget,
 *   storage, a symbolic link), the filter returns a WP_Error: WordPress reports the install as failed
 *   in plain words, an update restores its own backup, and the unpacked copy is dropped. Never silent.
 * - A plugin or theme the BUILD ships (WordPress core's themes, WooCommerce, imported ones) is
 *   deploy-only: installing over it is refused, and its update offer is hidden.
 * - A stored copy that boot could not load is named in an admin notice, and stays in the active list.
 */
if ( ! defined( 'SKYPHUSION_CODE_PERSIST' ) || true !== SKYPHUSION_CODE_PERSIST || ! function_exists( 'skyphusion_worker_call' ) ) {
	return;
}

function skyphusion_code_state_file( $name ) {
	$dir = defined( 'SKYPHUSION_CODE_STATE_DIR' ) ? SKYPHUSION_CODE_STATE_DIR : '/internal/shared';
	return $dir . '/' . $name;
}
function skyphusion_code_json( $name ) {
	$f = skyphusion_code_state_file( $name );
	if ( ! is_readable( $f ) ) {
		return array();
	}
	$d = json_decode( (string) file_get_contents( $f ), true );
	return is_array( $d ) ? $d : array();
}
function skyphusion_code_call( $op ) {
	$r = json_decode( (string) skyphusion_worker_call( json_encode( array( 'code' => $op ) ) ), true );
	return is_array( $r ) ? $r : array( 'ok' => false, 'error' => 'The Worker did not answer.' );
}
function skyphusion_code_shipped( $type, $slug ) {
	$s = skyphusion_code_json( 'code-build-slugs.json' );
	return isset( $s[ $type ] ) && in_array( $slug, $s[ $type ], true );
}
function skyphusion_code_type( $hook_extra, $upgrader = null ) {
	if ( is_array( $hook_extra ) && isset( $hook_extra['type'] ) && in_array( $hook_extra['type'], array( 'plugin', 'theme' ), true ) ) {
		return $hook_extra['type'];
	}
	if ( is_array( $hook_extra ) && isset( $hook_extra['theme'] ) ) {
		return 'theme';
	}
	if ( is_array( $hook_extra ) && isset( $hook_extra['plugin'] ) ) {
		return 'plugin';
	}
	if ( $upgrader && class_exists( 'Theme_Upgrader' ) && $upgrader instanceof Theme_Upgrader ) {
		return 'theme';
	}
	return 'plugin';
}

// Installing over a slug the build ships is refused before anything is moved into place.
add_filter(
	'upgrader_source_selection',
	function ( $source, $remote_source, $upgrader = null, $hook_extra = array() ) {
		if ( is_wp_error( $source ) ) {
			return $source;
		}
		$type = skyphusion_code_type( $hook_extra, $upgrader );
		$slug = basename( rtrim( (string) $source, '/' ) );
		if ( skyphusion_code_shipped( $type, $slug ) ) {
			return new WP_Error( 'skyphusion_code_shipped', sprintf( '%s ships with this site. It is updated by a deploy, not from wp-admin.', $slug ) );
		}
		return $source;
	},
	20,
	4
);

// Store an install or update; on failure, fail the install and drop the unpacked copy.
add_filter(
	'upgrader_post_install',
	function ( $response, $hook_extra, $result ) {
		if ( is_wp_error( $response ) || ! is_array( $result ) || empty( $result['destination_name'] ) ) {
			return $response;
		}
		$type = skyphusion_code_type( $hook_extra );
		$slug = (string) $result['destination_name'];
		$r    = skyphusion_code_call( array( 'op' => 'put', 'type' => $type, 'slug' => $slug ) );
		if ( ! empty( $r['ok'] ) ) {
			return $response;
		}
		skyphusion_code_call( array( 'op' => 'resync', 'type' => $type, 'slug' => $slug ) );
		return new WP_Error( 'skyphusion_code_store', isset( $r['error'] ) ? (string) $r['error'] : sprintf( '%s could not be stored, so it was not installed.', $slug ) );
	},
	20,
	3
);

// A delete from wp-admin forgets the stored copy.
add_action(
	'deleted_plugin',
	function ( $plugin_file, $deleted ) {
		$slug = dirname( (string) $plugin_file );
		if ( $deleted && '.' !== $slug ) {
			skyphusion_code_call( array( 'op' => 'delete', 'type' => 'plugin', 'slug' => $slug ) );
		}
	},
	10,
	2
);
add_action(
	'deleted_theme',
	function ( $stylesheet, $deleted ) {
		if ( $deleted ) {
			skyphusion_code_call( array( 'op' => 'delete', 'type' => 'theme', 'slug' => (string) $stylesheet ) );
		}
	},
	10,
	2
);

// Hide the update offer for what the build ships: those update with a deploy.
add_filter(
	'site_transient_update_plugins',
	function ( $t ) {
		if ( is_object( $t ) && ! empty( $t->response ) && is_array( $t->response ) ) {
			foreach ( array_keys( $t->response ) as $file ) {
				if ( skyphusion_code_shipped( 'plugin', dirname( $file ) ) ) {
					unset( $t->response[ $file ] );
				}
			}
		}
		return $t;
	}
);
add_filter(
	'site_transient_update_themes',
	function ( $t ) {
		if ( is_object( $t ) && ! empty( $t->response ) && is_array( $t->response ) ) {
			foreach ( array_keys( $t->response ) as $stylesheet ) {
				if ( skyphusion_code_shipped( 'theme', $stylesheet ) ) {
					unset( $t->response[ $stylesheet ] );
				}
			}
		}
		return $t;
	}
);

// A stored copy boot could not load: say so, and keep it in the active list so a passing storage
// fault does not turn into a silent deactivation (WordPress drops a missing plugin on plugins.php).
function skyphusion_code_refused_slugs( $type ) {
	$out = array();
	foreach ( skyphusion_code_json( 'code-refused.json' ) as $r ) {
		if ( isset( $r['type'], $r['slug'] ) && $type === $r['type'] ) {
			$out[] = (string) $r['slug'];
		}
	}
	return $out;
}
add_filter(
	'pre_update_option_active_plugins',
	function ( $new, $old ) {
		$refused = skyphusion_code_refused_slugs( 'plugin' );
		if ( ! $refused || ! is_array( $old ) || ! is_array( $new ) ) {
			return $new;
		}
		foreach ( $old as $file ) {
			if ( in_array( dirname( $file ), $refused, true ) && ! in_array( $file, $new, true ) ) {
				$new[] = $file;
			}
		}
		return $new;
	},
	10,
	2
);
add_action(
	'admin_notices',
	function () {
		$why = array(
			'missing'    => 'its stored copy is missing',
			'damaged'    => 'its stored copy does not match what was installed, so it was not run',
			'unreadable' => 'this site\'s storage could not be read just now',
		);
		foreach ( skyphusion_code_json( 'code-refused.json' ) as $r ) {
			if ( ! isset( $r['type'], $r['slug'], $r['reason'] ) ) {
				continue;
			}
			$reason = isset( $why[ $r['reason'] ] ) ? $why[ $r['reason'] ] : 'it could not be loaded';
			echo '<div class="notice notice-error"><p>' . esc_html( sprintf( 'The %s %s is not running: %s. Install it again from wp-admin.', $r['type'], $r['slug'], $reason ) ) . '</p></div>';
		}
	}
);
