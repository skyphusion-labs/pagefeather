<?php
// php spikes/b2-wordpress/tests/hyperdrive-qtrace-test.php [path/to/hyperdrive-qtrace.php]   (#296 step 3)
//
// The query trace's PHP half: a query carries its caller ("<area>:<file>::<function>") ONLY while the trace is on
// for this request. On means the request has x-pf-qtrace: 1 AND the Worker says so (it checks the spike token);
// without the header PHP never asks. The caller is built from frames without their arguments (no row data).

$GLOBALS['asked'] = 0;
$GLOBALS['answer'] = '1';
function skyphusion_worker_call( $json ) {
	$m = json_decode( $json, true );
	if ( isset( $m['qtraceOn'] ) ) {
		++$GLOBALS['asked'];
		return $GLOBALS['answer'];
	}
	return '{}';
}
require isset( $argv[1] ) ? $argv[1] : __DIR__ . '/../php/hyperdrive-qtrace.php';

$fail = 0;
function check( $label, $cond ) {
	global $fail;
	echo ( $cond ? 'ok   ' : 'FAIL ' ) . $label . "\n";
	$fail += $cond ? 0 : 1;
}
function fresh() {
	unset( $GLOBALS['skyphusion_hd_qtrace'] );
	$GLOBALS['asked'] = 0;
}

fresh();
unset( $_SERVER['HTTP_X_PF_QTRACE'] );
check( 'no header: off, and PHP never asks the Worker', false === skyphusion_hd_qtrace_on() && 0 === $GLOBALS['asked'] );
fresh();
$_SERVER['HTTP_X_PF_QTRACE'] = 'yes';
check( 'a header other than 1: off, never asks', false === skyphusion_hd_qtrace_on() && 0 === $GLOBALS['asked'] );
fresh();
$_SERVER['HTTP_X_PF_QTRACE'] = '1';
$GLOBALS['answer'] = '0';
check( 'header 1, the Worker says no (no spike token): off', false === skyphusion_hd_qtrace_on() && 1 === $GLOBALS['asked'] );
fresh();
$GLOBALS['answer'] = '1';
$a = skyphusion_hd_qtrace_on();
$b = skyphusion_hd_qtrace_on();
$c = skyphusion_hd_qtrace_on();
check( 'header 1, the Worker says yes: on, and it asks ONCE per request', true === $a && $b && $c && 1 === $GLOBALS['asked'] );

$W = '/internal/shared/wordpress';
$f = function ( $file, $fn = null, $class = null ) {
	return array_filter( array( 'file' => $file, 'line' => 10, 'function' => $fn, 'class' => $class, 'args' => array( 'load@example.com' ) ), function ( $v ) { return null !== $v; } );
};
// debug_backtrace order: [0] is the innermost call. Frame k's file:line is INSIDE the function named by frame k+1.
$frames = array(
	$f( "$W/wp-content/db.php", 'skyphusion_hd_caller' ),
	$f( "$W/wp-content/db.php", 'skyphusion_hd_call' ),
	$f( "$W/wp-includes/class-wpdb.php", 'query', 'Hyperdrive_WPDB' ),
	$f( "$W/wp-content/plugins/woocommerce/includes/data-stores/class-wc-product-data-store-cpt.php", 'get_results', 'wpdb' ),
	$f( "$W/wp-content/plugins/woocommerce/includes/class-wc-product.php", 'read_attributes', 'WC_Product_Data_Store_CPT' ),
);
check( 'a WooCommerce data store query: plugin:woocommerce, its file, the function the line is in', 'plugin:woocommerce:class-wc-product-data-store-cpt.php::WC_Product_Data_Store_CPT->read_attributes' === skyphusion_hd_caller( $frames ) );
check( 'no argument ever reaches the caller', false === strpos( skyphusion_hd_caller( $frames ), 'example.com' ) );
$core = array( $f( "$W/wp-content/db.php", 'skyphusion_hd_call' ), $f( "$W/wp-includes/class-wpdb.php", 'query', 'Hyperdrive_WPDB' ), $f( "$W/wp-includes/option.php", 'get_row', 'wpdb' ), $f( "$W/wp-settings.php", 'get_option' ) );
check( 'core: core:option.php::get_option', 'core:option.php::get_option' === skyphusion_hd_caller( $core ) );
$theme = array( $f( "$W/wp-content/db.php", 'x' ), $f( "$W/wp-content/themes/storefront/inc/x.php", 'get_var', 'wpdb' ) );
check( 'theme: theme:storefront:x.php::main (no enclosing function)', 'theme:storefront:x.php::main' === skyphusion_hd_caller( $theme ) );
$mu = array( $f( "$W/wp-content/db.php", 'x' ), $f( "$W/wp-content/mu-plugins/r2-uploads.php", 'query', 'wpdb' ), $f( "$W/wp-includes/plugin.php", 'r2_fn' ) );
check( 'mu-plugin: mu:r2-uploads.php::r2_fn', 'mu:r2-uploads.php::r2_fn' === skyphusion_hd_caller( $mu ) );
$drop = array( $f( "$W/wp-content/db.php", 'x' ), $f( "$W/wp-content/object-cache.php", 'get_results', 'wpdb' ), $f( "$W/wp-includes/cache.php", 'version_gate', 'JS_Object_Cache' ) );
check( 'drop-in: dropin:object-cache.php::JS_Object_Cache->version_gate', 'dropin:object-cache.php::JS_Object_Cache->version_gate' === skyphusion_hd_caller( $drop ) );
check( 'only the trace frames: ?', '?' === skyphusion_hd_caller( array( $f( "$W/wp-content/db.php", 'x' ) ) ) );
check( 'a live backtrace is classified (it runs here, outside WordPress: core)', 0 === strpos( skyphusion_hd_caller(), 'core:' ) );

echo $fail ? "$fail failing check(s)\n" : "all checks pass\n";
exit( $fail ? 1 : 0 );
