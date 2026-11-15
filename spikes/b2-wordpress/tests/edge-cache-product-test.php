<?php
// edge-cache.php marks a WooCommerce product, shop or product-category page with x-pf-page: product
// (C2 of #628). The Worker reads the mark for PAGE_CACHE_PRODUCT_TTL and removes it. This checks the
// decision, with WordPress and WooCommerce stubbed. Run: php spikes/b2-wordpress/tests/edge-cache-product-test.php
$GLOBALS['actions'] = array();
function add_action( $hook, $fn, $prio = 10 ) { $GLOBALS['actions'][ $hook ][] = $fn; }
function post_message_to_js( $m ) { return ''; }
$GLOBALS['wc'] = array( 'product' => false, 'shop' => false, 'tax' => false );
$bad = 0;
function check( $name, $ok ) { global $bad; echo ( $ok ? 'PASS ' : 'FAIL ' ) . $name . "\n"; if ( ! $ok ) { $bad++; } }

require __DIR__ . '/../php/edge-cache.php';

check( 'the decision function exists', function_exists( 'skyphusion_edge_cache_is_product_page' ) );
check( 'no WooCommerce: not a product page', function_exists( 'skyphusion_edge_cache_is_product_page' ) && false === skyphusion_edge_cache_is_product_page() );

function is_product() { return $GLOBALS['wc']['product']; }
function is_shop() { return $GLOBALS['wc']['shop']; }
function is_product_taxonomy() { return $GLOBALS['wc']['tax']; }

if ( function_exists( 'skyphusion_edge_cache_is_product_page' ) ) {
	check( 'a post or page is not a product page', false === skyphusion_edge_cache_is_product_page() );
	foreach ( array( 'product', 'shop', 'tax' ) as $k ) {
		$GLOBALS['wc'] = array( 'product' => false, 'shop' => false, 'tax' => false );
		$GLOBALS['wc'][ $k ] = true;
		check( "a $k page is a product page", true === skyphusion_edge_cache_is_product_page() );
	}
}
check( 'the mark is sent on template_redirect', ! empty( $GLOBALS['actions']['template_redirect'] ) );

if ( $bad ) { echo "$bad FAILED\n"; exit( 1 ); }
echo "edge-cache-product-test: all pass\n";
