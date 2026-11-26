<?php
/**
 * Plugin Name: Demo store notice
 * Description: On a DEMO_LOCK site, the home page names the Pagefeather variant and demo data.
 *
 * Inert unless PAGEFEATHER_DEMO_STORE is true (site-lock.mjs when DEMO_LOCK=on). Plain STE copy.
 * No signup link and no upsell. Prints once on the front page only (the_content; not wp_body_open).
 */

if ( ! defined( 'PAGEFEATHER_DEMO_STORE' ) || true !== PAGEFEATHER_DEMO_STORE ) {
	return;
}

/**
 * The storage variant named on the home page.
 *
 * @return string
 */
function pagefeather_demo_store_variant() {
	if ( defined( 'PAGEFEATHER_DEMO_VARIANT' ) ) {
		if ( 'b-dosql' === PAGEFEATHER_DEMO_VARIANT ) {
			return 'the Pagefeather b-dosql variant, with its built-in SQLite database';
		}
		if ( 'hyperdrive' === PAGEFEATHER_DEMO_VARIANT ) {
			return 'the Pagefeather approach A variant, with MySQL through Hyperdrive';
		}
	}
	return 'a database variant that is not identified';
}

/**
 * The home-page lines. One idea per sentence.
 *
 * @return string[]
 */
function pagefeather_demo_store_lines() {
	$lines = array(
		'This is a demo site of the Pagefeather framework.',
		'Pagefeather runs WordPress on Cloudflare.',
		'This demo runs on ' . pagefeather_demo_store_variant() . '.',
	);
	if ( class_exists( 'WooCommerce' ) ) {
		$lines[] = 'WooCommerce is active here. Its catalog and orders are sample data for testing.';
	} else {
		$lines[] = 'The content is sample data for testing.';
	}
	$lines[] = 'Nothing here is for sale.';
	return $lines;
}

/**
 * @return string HTML paragraphs for the front page.
 */
function pagefeather_demo_store_html() {
	$out = '';
	foreach ( pagefeather_demo_store_lines() as $line ) {
		$out .= '<p>' . esc_html( $line ) . '</p>';
	}
	return $out;
}

add_filter(
	'pre_option_blogdescription',
	static function ( $value ) {
		if ( is_admin() ) {
			return $value;
		}
		if ( defined( 'PAGEFEATHER_DEMO_VARIANT' ) && 'b-dosql' === PAGEFEATHER_DEMO_VARIANT ) {
			return 'Pagefeather demo site, b-dosql';
		}
		if ( defined( 'PAGEFEATHER_DEMO_VARIANT' ) && 'hyperdrive' === PAGEFEATHER_DEMO_VARIANT ) {
			return 'Pagefeather demo site, Hyperdrive';
		}
		return 'Pagefeather demo site';
	}
);

// Once only: the main front-page content. is_singular() keeps a posts home from
// repeating the block on every loop post. No wp_body_open twin.
add_filter(
	'the_content',
	static function ( $content ) {
		if ( ! is_front_page() || ! is_singular() || ! in_the_loop() || ! is_main_query() ) {
			return $content;
		}
		$marker = 'pagefeather-demo-store';
		if ( is_string( $content ) && false !== strpos( $content, $marker ) ) {
			return $content;
		}
		$block  = '<aside class="' . esc_attr( $marker ) . '" role="note">';
		$block .= pagefeather_demo_store_html();
		$block .= '</aside>';
		return $block . $content;
	},
	5
);
