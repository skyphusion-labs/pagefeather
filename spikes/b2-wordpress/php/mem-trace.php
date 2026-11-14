<?php
/**
 * Plugin Name: Memory trace (spike, #434)
 * Description: Where an admin page spends memory, by component. Operator-only: it runs only
 *   when the request carries x-mem-trace, and index.js passes that header (and x-mem-off) to
 *   PHP only with a valid x-spike-token, as it does x-oc-off. A visitor can neither turn it on
 *   nor switch anything off.
 *
 * At each checkpoint along the boot it records [name, memory_get_usage, memory_get_peak_usage,
 * live WASM heap bytes, included files]. Under USE_ZEND_ALLOC=0 (the b-dosql default) the two
 * Zend numbers read 0, and the WASM heap (probeMem, the same bridge /_runcron's profile uses) is
 * the memory of record; it grows in steps and never shrinks. A run with USE_ZEND_ALLOC=1
 * (deploy/wfp WFP_PHP_ENV) gives the finer Zend attribution.
 *
 * x-mem-off (comma list) switches ONE component off for this request, so a page's peak can be
 * compared with and without it:
 *   woo       WooCommerce is not loaded (option_active_plugins without it)
 *   plugin=<slug>  any one plugin is not loaded, by its directory name (tier 1, #422)
 *   wcadmin   woocommerce_admin_disabled (measured: WooCommerce 11 barely honours it)
 *   wcfeatures the wc-admin feature list is emptied (woocommerce_admin_features)
 *   wcblocks  WooCommerce registers no block types or patterns (woocommerce_should_register_blocks,
 *             the gate WooCommerce itself uses on its own admin pages; #504)
 *   preload   the block editor REST preload paths are emptied (post-new.php, post.php)
 *   updates   the core, plugin and theme update checks are not hooked on admin_init
 *   dashboard the dashboard widgets are not set up
 *   notices   admin_notices callbacks are removed
 *   l10n      translations are not loaded (override_load_textdomain)
 * x-mem-trace: hooks (#504) adds three things, for WooCommerce's boot: a mark per plugin include
 *   (inc:<slug>, on plugin_loaded), a priority sweep (p:<hook>@<priority>, one mark after each
 *   registered priority of plugins_loaded, after_setup_theme, init, wp_loaded and admin_init, with
 *   the bucket's owner names), and WooCommerce's included files by subtree at every mark. Owner
 *   names are class and function names only, never callback arguments or values: the marks land
 *   in logs. Any other x-mem-trace value gives the default trace, unchanged.
 * At shutdown the trace goes to the Worker (post_message_to_js memTrace), which sets the
 * operator-only x-mem-trace response header. Numbers and component names only.
 */

if ( empty( $_SERVER['HTTP_X_MEM_TRACE'] ) || ! function_exists( 'post_message_to_js' ) ) {
	return;
}

$GLOBALS['skyphusion_mem'] = array(
	'm'       => array(),
	'off'     => array(),
	'preload' => null,
	'hooks'   => 'hooks' === strtolower( trim( (string) $_SERVER['HTTP_X_MEM_TRACE'] ) ),
);

function skyphusion_mem_wasm() {
	$r = json_decode( post_message_to_js( json_encode( array( 'probeMem' => 1 ) ) ), true );
	return ( is_array( $r ) && isset( $r['wasm'] ) ) ? (int) $r['wasm'] : null;
}

// The operator's x-perf-id (#434), so the logged marks of a request killed by a reset can be
// joined to the Worker's reset line. index.js logs it only if it is a short safe token.
function skyphusion_mem_id() {
	$id = isset( $_SERVER['HTTP_X_PERF_ID'] ) ? (string) $_SERVER['HTTP_X_PERF_ID'] : '';
	return preg_match( '/^[A-Za-z0-9_.-]{1,64}$/', $id ) ? $id : null;
}

// WooCommerce's included files by subtree (hooks mode): directory names only.
function skyphusion_mem_woo_files() {
	$g = array();
	foreach ( get_included_files() as $f ) {
		$p = strpos( $f, '/plugins/woocommerce/' );
		if ( false === $p ) {
			continue;
		}
		$rest = substr( $f, $p + 21 );
		if ( 0 === strncmp( $rest, 'src/', 4 ) ) {
			$parts = explode( '/', $rest );
			$k     = ( isset( $parts[2] ) && preg_match( '/^[A-Za-z0-9_]{1,40}$/', $parts[1] ) ) ? 'src/' . $parts[1] : 'src';
		} elseif ( 0 === strncmp( $rest, 'includes/admin/', 15 ) ) {
			$k = 'includes/admin';
		} elseif ( 0 === strncmp( $rest, 'includes/', 9 ) ) {
			$k = 'includes';
		} elseif ( 0 === strncmp( $rest, 'packages/', 9 ) ) {
			$k = 'packages';
		} elseif ( 0 === strncmp( $rest, 'vendor/', 7 ) ) {
			$k = 'vendor';
		} else {
			$k = 'other';
		}
		$g[ $k ] = isset( $g[ $k ] ) ? $g[ $k ] + 1 : 1;
	}
	ksort( $g );
	return $g;
}

function skyphusion_mem_mark( $name, $extra = null ) {
	$mark = array( $name, memory_get_usage(), memory_get_peak_usage(), skyphusion_mem_wasm(), count( get_included_files() ) );
	if ( $GLOBALS['skyphusion_mem']['hooks'] ) {
		$mark[] = skyphusion_mem_woo_files();
		$mark[] = $extra;
	}
	$GLOBALS['skyphusion_mem']['m'][] = $mark;
	// Each mark is also logged as it happens (index.js memMark, a Workers Logs line), so a request
	// that the isolate reset kills still shows how far it got and what the heap was.
	post_message_to_js( json_encode( array( 'memMark' => $mark, 'id' => skyphusion_mem_id() ) ) );
}

// Checkpoints. Each pair brackets one stretch of the boot: the growth between two marks is
// that stretch's cost. PHP_INT_MIN runs before every other callback of the hook, PHP_INT_MAX after.
function skyphusion_mem_at( $hook, $first, $last ) {
	add_action( $hook, function () use ( $first ) { skyphusion_mem_mark( $first ); }, PHP_INT_MIN );
	if ( $last ) {
		add_action( $hook, function () use ( $last ) { skyphusion_mem_mark( $last ); }, PHP_INT_MAX );
	}
}

skyphusion_mem_mark( 'mu' );

// ---- hooks mode (#504) ------------------------------------------------------------------------
// The name of a callback's owner: Class::method or the function name, with the WooCommerce
// namespace prefix cut, or closure@<file name>. Never an argument or a value. The second item says
// whether the code lives under plugins/woocommerce/.
function skyphusion_mem_owner( $cb ) {
	$fn   = is_array( $cb ) && isset( $cb['function'] ) ? $cb['function'] : null;
	$name = '?';
	try {
		if ( $fn instanceof Closure ) {
			$r    = new ReflectionFunction( $fn );
			$name = 'closure@' . basename( (string) $r->getFileName() );
		} elseif ( is_string( $fn ) && false !== strpos( $fn, '::' ) ) {
			list( $c, $m ) = explode( '::', $fn, 2 );
			$r    = new ReflectionMethod( $c, $m );
			$name = $c . '::' . $m;
		} elseif ( is_string( $fn ) ) {
			$r    = new ReflectionFunction( $fn );
			$name = $fn;
		} elseif ( is_array( $fn ) && 2 === count( $fn ) ) {
			$c    = is_object( $fn[0] ) ? get_class( $fn[0] ) : (string) $fn[0];
			$r    = new ReflectionMethod( $c, (string) $fn[1] );
			$name = $c . '::' . (string) $fn[1];
		} elseif ( is_object( $fn ) ) {
			$r    = new ReflectionMethod( $fn, '__invoke' );
			$name = get_class( $fn ) . '::__invoke';
		} else {
			return array( '?', false );
		}
		$file = (string) $r->getFileName();
	} catch ( \Throwable $e ) {
		return array( substr( $name, 0, 80 ), false );
	}
	$name = preg_replace( '/^Automattic\\\\WooCommerce\\\\/', '', $name );
	return array( substr( $name, 0, 80 ), false !== strpos( $file, '/plugins/woocommerce/' ), $file );
}

// One mark after each priority registered on $hook when it starts: the growth between two marks
// is that priority bucket's cost, named by who ran in it. A priority first registered DURING the
// hook is not swept, and a callback added later to a swept priority runs after its mark.
function skyphusion_mem_sweep( $hook ) {
	add_action(
		$hook,
		function () use ( $hook ) {
			global $wp_filter;
			if ( ! isset( $wp_filter[ $hook ] ) || ! is_object( $wp_filter[ $hook ] ) ) {
				return;
			}
			$self = __FILE__;
			foreach ( $wp_filter[ $hook ]->callbacks as $p => $cbs ) {
				if ( PHP_INT_MIN === $p || PHP_INT_MAX === $p ) {
					continue;
				}
				// WooCommerce's owners first: the list is capped at 6, and a bucket like init@10 holds
				// over 100 core callbacks ahead of WooCommerce's (pf504z, #504).
				$wowners = array();
				$owners  = array();
				$n       = 0;
				$woo     = 0;
				foreach ( $cbs as $cb ) {
					$o = skyphusion_mem_owner( $cb );
					if ( isset( $o[2] ) && $o[2] === $self ) {
						continue; // the trace's own callbacks
					}
					++$n;
					if ( $o[1] ) {
						++$woo;
						$wowners[] = $o[0];
					} else {
						$owners[] = $o[0];
					}
				}
				$owners = array_slice( array_merge( $wowners, $owners ), 0, 6 );
				if ( ! $n ) {
					continue;
				}
				$label = 'p:' . $hook . '@' . $p;
				$extra = array( 'n' => $n, 'woo' => $woo, 'o' => $owners );
				add_action(
					$hook,
					function () use ( $label, $extra ) {
						skyphusion_mem_mark( $label, $extra );
					},
					$p
				);
			}
		},
		PHP_INT_MIN
	);
}

if ( $GLOBALS['skyphusion_mem']['hooks'] ) {
	add_action(
		'muplugins_loaded',
		function () {
			skyphusion_mem_mark( 'mu_done' );
		},
		PHP_INT_MAX
	);
	add_action(
		'plugin_loaded',
		function ( $file ) {
			$file = (string) $file;
			$dir  = basename( dirname( $file ) );
			$slug = ( 'plugins' === $dir || '' === $dir || '.' === $dir ) ? basename( $file, '.php' ) : $dir;
			$slug = substr( preg_replace( '/[^a-z0-9_-]/', '', strtolower( $slug ) ), 0, 40 );
			skyphusion_mem_mark( 'inc:' . ( '' === $slug ? '?' : $slug ) );
		},
		PHP_INT_MAX
	);
	foreach ( array( 'plugins_loaded', 'after_setup_theme', 'init', 'wp_loaded', 'admin_init' ) as $skyphusion_mem_hook ) {
		skyphusion_mem_sweep( $skyphusion_mem_hook );
	}
	unset( $skyphusion_mem_hook );
}
skyphusion_mem_at( 'plugins_loaded', 'plugins_included', 'plugins_loaded' );
skyphusion_mem_at( 'after_setup_theme', 'theme', null );
skyphusion_mem_at( 'init', 'init_start', 'init_end' );
skyphusion_mem_at( 'wp_loaded', 'wp_loaded', null );
skyphusion_mem_at( 'admin_init', 'admin_init_start', 'admin_init_end' );
skyphusion_mem_at( 'current_screen', 'screen', null );
skyphusion_mem_at( 'admin_enqueue_scripts', 'enqueue_start', 'enqueue_end' );
skyphusion_mem_at( 'admin_footer', 'footer', null );
skyphusion_mem_at( 'admin_print_footer_scripts', 'footer_scripts_start', 'footer_scripts_end' );

// Each REST request the block editor preload runs in-process gets its own mark (route only).
add_filter(
	'rest_post_dispatch',
	function ( $result, $server, $request ) {
		if ( null !== $GLOBALS['skyphusion_mem']['preload'] && is_object( $request ) && method_exists( $request, 'get_route' ) ) {
			skyphusion_mem_mark( 'rest:' . substr( preg_replace( '/[^A-Za-z0-9\/_-]/', '', (string) $request->get_route() ), 0, 60 ) );
		}
		return $result;
	},
	PHP_INT_MAX,
	3
);
skyphusion_mem_at( 'rest_api_init', 'rest_init', 'rest_init_end' );
// The admin page head and body before the footer: pass B (#434) saw 18.4 MiB grow between
// enqueue_end and footer on the dashboard, profile and product list, with WooCommerce on only.
skyphusion_mem_at( 'admin_head', 'head_start', 'head_end' );
skyphusion_mem_at( 'admin_print_scripts', 'head_scripts_start', 'head_scripts_end' );
skyphusion_mem_at( 'in_admin_header', 'admin_header', null );
skyphusion_mem_at( 'all_admin_notices', 'notices_start', 'notices_end' );

// The block editor preload: it runs REST requests in-process (block_editor_rest_api_preload).
// The paths filter runs just before them, block_editor_settings_all just after.
add_filter(
	'block_editor_rest_api_preload_paths',
	function ( $paths ) {
		$GLOBALS['skyphusion_mem']['preload'] = is_array( $paths ) ? count( $paths ) : null;
		skyphusion_mem_mark( 'preload_start' );
		return $paths;
	},
	PHP_INT_MAX - 1
);
add_filter(
	'block_editor_settings_all',
	function ( $s ) {
		skyphusion_mem_mark( 'preload_end' );
		return $s;
	},
	PHP_INT_MIN
);

// ---- the switches (x-mem-off) -----------------------------------------------------------------
$skyphusion_mem_off = array_filter( array_map( 'trim', explode( ',', strtolower( (string) ( isset( $_SERVER['HTTP_X_MEM_OFF'] ) ? $_SERVER['HTTP_X_MEM_OFF'] : '' ) ) ) ) );
// plugin=<slug> switches one plugin off by its directory name (tier 1, #422): the generic form of
// woo. Only a plugin directory name WordPress could have made is accepted.
$skyphusion_mem_plugins = array();
foreach ( $skyphusion_mem_off as $o ) {
	if ( preg_match( '/^plugin=([a-z0-9][a-z0-9_-]{0,63})$/', $o, $mm ) ) {
		$skyphusion_mem_plugins[] = $mm[1];
	}
}
$skyphusion_mem_off = array_values( array_intersect( $skyphusion_mem_off, array( 'woo', 'wcadmin', 'wcfeatures', 'wcblocks', 'preload', 'updates', 'dashboard', 'notices', 'l10n' ) ) );
if ( in_array( 'woo', $skyphusion_mem_off, true ) ) {
	$skyphusion_mem_plugins[] = 'woocommerce';
}
foreach ( $skyphusion_mem_plugins as $slug ) {
	if ( 'woocommerce' !== $slug ) {
		$skyphusion_mem_off[] = 'plugin=' . $slug;
	}
}
$GLOBALS['skyphusion_mem']['off'] = $skyphusion_mem_off;

if ( $skyphusion_mem_plugins ) {
	add_filter(
		'option_active_plugins',
		function ( $p ) use ( $skyphusion_mem_plugins ) {
			if ( ! is_array( $p ) ) {
				return $p;
			}
			return array_values(
				array_filter(
					$p,
					function ( $file ) use ( $skyphusion_mem_plugins ) {
						return ! in_array( strtok( (string) $file, '/' ), $skyphusion_mem_plugins, true );
					}
				)
			);
		}
	);
}
if ( in_array( 'wcadmin', $skyphusion_mem_off, true ) ) {
	add_filter( 'woocommerce_admin_disabled', '__return_true' );
}
// woocommerce_admin_disabled barely changes WooCommerce 11 (pf422a, #434: 149 to 137 wc-admin
// files), so wcfeatures empties the wc-admin feature list instead (src/Admin/Features/Features.php).
if ( in_array( 'wcfeatures', $skyphusion_mem_off, true ) ) {
	add_filter( 'woocommerce_admin_features', '__return_empty_array', PHP_INT_MAX );
}
// wcblocks: WooCommerce 11.2 already skips its eager block and pattern registration on its own admin
// pages and on non-rendering requests (src/Blocks/Domain/BlockRegistrationContext.php), through this
// filter. Core admin screens still register every block type; this switch measures that cost (#504).
if ( in_array( 'wcblocks', $skyphusion_mem_off, true ) ) {
	add_filter( 'woocommerce_should_register_blocks', '__return_false', PHP_INT_MAX );
}
if ( in_array( 'preload', $skyphusion_mem_off, true ) ) {
	add_filter( 'block_editor_rest_api_preload_paths', '__return_empty_array', PHP_INT_MAX );
}
if ( in_array( 'updates', $skyphusion_mem_off, true ) ) {
	add_action(
		'init',
		function () {
			foreach ( array( '_maybe_update_core', '_maybe_update_plugins', '_maybe_update_themes' ) as $f ) {
				remove_action( 'admin_init', $f );
			}
			remove_action( 'load-plugins.php', 'wp_update_plugins' );
			remove_action( 'load-update-core.php', 'wp_update_plugins' );
			remove_action( 'load-themes.php', 'wp_update_themes' );
		},
		PHP_INT_MAX
	);
}
if ( in_array( 'dashboard', $skyphusion_mem_off, true ) ) {
	add_action(
		'wp_dashboard_setup',
		function () {
			$GLOBALS['wp_meta_boxes']['dashboard'] = array();
		},
		PHP_INT_MAX
	);
}
if ( in_array( 'notices', $skyphusion_mem_off, true ) ) {
	add_action(
		'admin_init',
		function () {
			remove_all_actions( 'admin_notices' );
			remove_all_actions( 'all_admin_notices' );
		},
		PHP_INT_MAX
	);
}
if ( in_array( 'l10n', $skyphusion_mem_off, true ) ) {
	add_filter( 'override_load_textdomain', '__return_true', PHP_INT_MAX );
}

// ---- at the end ------------------------------------------------------------------------------
register_shutdown_function(
	function () {
		skyphusion_mem_mark( 'shutdown' );
		$t = $GLOBALS['skyphusion_mem'];
		$groups = array();
		foreach ( get_included_files() as $f ) {
			if ( false !== strpos( $f, '/plugins/woocommerce/src/Admin/' ) || false !== strpos( $f, '/plugins/woocommerce/src/Internal/Admin/' ) ) {
				$g = 'woo_admin';
			} elseif ( false !== strpos( $f, '/plugins/woocommerce/' ) ) {
				$g = 'woo';
			} elseif ( false !== strpos( $f, '/mu-plugins/' ) ) {
				$g = 'mu';
			} elseif ( false !== strpos( $f, '/plugins/' ) ) {
				$g = 'plugins';
			} elseif ( false !== strpos( $f, '/wp-admin/' ) ) {
				$g = 'wp_admin';
			} elseif ( false !== strpos( $f, '/wp-includes/' ) ) {
				$g = 'wp_includes';
			} elseif ( false !== strpos( $f, '/themes/' ) ) {
				$g = 'theme';
			} else {
				$g = 'other';
			}
			$groups[ $g ] = isset( $groups[ $g ] ) ? $groups[ $g ] + 1 : 1;
		}
		$alloptions = function_exists( 'wp_load_alloptions' ) ? wp_load_alloptions() : array();
		$trace = array(
			'v'          => 1,
			'off'        => $t['off'],
			'm'          => $t['hooks'] ? array_map( function ( $mk ) { return array_slice( $mk, 0, 5 ); }, $t['m'] ) : $t['m'],
			'mode'       => $t['hooks'] ? 'hooks' : 'default',
			'files'      => $groups,
			'alloptions' => array( count( $alloptions ), strlen( serialize( $alloptions ) ) ),
			'l10n'       => isset( $GLOBALS['l10n'] ) && is_array( $GLOBALS['l10n'] ) ? count( $GLOBALS['l10n'] ) : 0,
			'locale'     => function_exists( 'determine_locale' ) ? determine_locale() : null,
			'preload'    => $t['preload'],
			'zend'       => getenv( 'USE_ZEND_ALLOC' ),
		);
		post_message_to_js( json_encode( array( 'memTrace' => $trace ) ) );
	}
);
