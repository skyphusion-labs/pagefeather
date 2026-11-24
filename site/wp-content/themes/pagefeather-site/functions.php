<?php
/**
 * Pagefeather marketing theme.
 *
 * @package Pagefeather_Site
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
	exit;
}

add_action('after_setup_theme', static function (): void {
	add_theme_support('title-tag');
	add_theme_support('html5', ['search-form', 'comment-form', 'comment-list', 'gallery', 'caption', 'style', 'script']);
	remove_action('wp_head', 'print_emoji_detection_script', 7);
	remove_action('wp_print_styles', 'print_emoji_styles');
});

add_action('wp_enqueue_scripts', static function (): void {
	$uri = get_template_directory_uri();
	$path = get_template_directory();
	$fonts_ver = (string) filemtime($path . '/assets/css/fonts.css');
	$css_ver = (string) filemtime($path . '/assets/css/site.css');
	$js_ver = (string) filemtime($path . '/assets/js/site.js');

	wp_enqueue_style('pagefeather-fonts', $uri . '/assets/css/fonts.css', [], $fonts_ver);
	wp_enqueue_style('pagefeather-site', $uri . '/assets/css/site.css', ['pagefeather-fonts'], $css_ver);
	wp_enqueue_script('pagefeather-site', $uri . '/assets/js/site.js', [], $js_ver, true);

	// Preload display fonts for the first viewport.
	add_action('wp_head', static function () use ($uri): void {
		$faces = [
			'dm-sans.woff2',
			'instrument-serif.woff2',
			'instrument-serif-italic.woff2',
			'jetbrains-mono.woff2',
		];
		foreach ($faces as $face) {
			printf(
				'<link rel="preload" href="%s" as="font" type="font/woff2" crossorigin>' . "\n",
				esc_url($uri . '/assets/fonts/' . $face)
			);
		}
	}, 1);
}, 20);

add_filter('document_title_parts', static function (array $parts): array {
	if (is_front_page()) {
		$parts['title'] = 'Pagefeather';
		$parts['tagline'] = 'WordPress and WooCommerce on your Cloudflare account';
	}
	return $parts;
});

/**
 * Current path helper for nav active state.
 */
function pagefeather_current_path(): string
{
	$path = wp_parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
	$path = is_string($path) ? untrailingslashit($path) : '';
	return $path === '' ? '/' : $path . '/';
}

/**
 * Nav items for the marketing site.
 *
 * @return list<array{label:string,href:string,accent?:bool}>
 */
function pagefeather_nav_items(): array
{
	return [
		['label' => 'How it works', 'href' => '/how-it-works/'],
		['label' => 'Limits', 'href' => '/limits/'],
		['label' => 'Get started', 'href' => '/get-started/'],
		['label' => 'Evidence', 'href' => '/evidence/'],
		['label' => 'About', 'href' => '/about/'],
		['label' => 'GitHub', 'href' => 'https://github.com/skyphusion-labs/pagefeather', 'accent' => true],
	];
}
