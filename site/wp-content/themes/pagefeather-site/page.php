<?php
/**
 * Generic page: prefer designed slug templates; fall back to clean prose.
 *
 * @package Pagefeather_Site
 */
get_header();
?>
<main id="main" class="shell">
	<?php while (have_posts()) : the_post(); ?>
		<div class="page-hero reveal">
			<p class="hero-eyebrow">Pagefeather</p>
			<h1><?php the_title(); ?></h1>
		</div>
		<article class="prose reveal">
			<?php the_content(); ?>
		</article>
	<?php endwhile; ?>
</main>
<?php
get_footer();
