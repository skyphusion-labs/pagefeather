<?php
/**
 * Site header.
 *
 * @package Pagefeather_Site
 */
if (!defined('ABSPATH')) {
	exit;
}
$current = pagefeather_current_path();
?><!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
	<meta charset="<?php bloginfo('charset'); ?>">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta name="description" content="WordPress and WooCommerce on Cloudflare, in your own Cloudflare account. Open source. No hosted funnel.">
	<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<script>document.documentElement.classList.add("js");</script>
<a class="skip" href="#main">Skip to content</a>
<div class="atmosphere" aria-hidden="true">
	<div class="grid-field"></div>
	<div class="glow glow--left"></div>
	<div class="glow glow--right"></div>
</div>
<header class="shell">
	<nav class="nav" aria-label="Primary">
		<a class="nav-link<?php echo $current === '/' ? ' is-active' : ''; ?>" href="/">Pagefeather</a>
		<?php foreach (pagefeather_nav_items() as $item) :
			$href = $item['href'];
			$external = str_starts_with($href, 'http');
			$active = !$external && ($current === $href);
			$cls = 'nav-link' . (!empty($item['accent']) ? ' nav-link--accent' : '') . ($active ? ' is-active' : '');
			?>
			<a class="<?php echo esc_attr($cls); ?>" href="<?php echo esc_url($href); ?>"<?php echo $external ? ' rel="noopener noreferrer"' : ''; ?>><?php echo esc_html($item['label']); ?></a>
		<?php endforeach; ?>
	</nav>
</header>
