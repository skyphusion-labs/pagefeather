<?php
/**
 * Plugin Name: Demo store notice
 * Description: On a DEMO_LOCK site, the home page says this is a Pagefeather demo store (#catalog gate).
 *
 * Inert unless PAGEFEATHER_DEMO_STORE is true (site-lock.mjs when DEMO_LOCK=on). Plain STE copy.
 * No signup link and no upsell. Prints once on the front page only (the_content; not wp_body_open).
 */

if ( ! defined( 'PAGEFEATHER_DEMO_STORE' ) || true !== PAGEFEATHER_DEMO_STORE ) {
	return;
}

/**
 * The home-page lines. One idea per sentence.
 *
 * @return string[]
 */
function pagefeather_demo_store_lines() {
	return array(
		'This is a demo store of the Pagefeather framework.',
		'Pagefeather runs WordPress and WooCommerce on Cloudflare.',
		'The catalog is sample data for testing.',
		'Nothing here is for sale.',
	);
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
		return 'Pagefeather demo store';
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
