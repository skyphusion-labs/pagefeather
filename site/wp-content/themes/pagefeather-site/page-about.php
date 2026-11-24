<?php
/**
 * About.
 *
 * @package Pagefeather_Site
 */
get_header();
?>
<main id="main" class="shell">
	<div class="page-hero reveal">
		<p class="hero-eyebrow">Project</p>
		<h1>About <em>Pagefeather</em></h1>
		<p class="lede">An open-source framework for WordPress and WooCommerce on Cloudflare. Two paths ship today. You run everything in your own account.</p>
	</div>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">Stance</p>
			<h2>What we will not do</h2>
		</div>
		<div class="card-grid">
			<article class="card">
				<h3>No hosted product</h3>
				<p>There is no Pagefeather cloud. Your Cloudflare account runs the site.</p>
			</article>
			<article class="card">
				<h3>No funnel</h3>
				<p>No upsell. Friendly never means selling. Limits sit next to capabilities.</p>
			</article>
			<article class="card">
				<h3>No soft tests</h3>
				<p>Do not make a test pass by softening the harness. Fix the engine or the install. You may exclude a case; write the reason and the issue next to it.</p>
			</article>
			<article class="card">
				<h3>Measured only</h3>
				<p>A result is measured only after a real deploy and a test. Documentation alone is not a measurement.</p>
			</article>
		</div>
	</section>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">Facts</p>
			<h2>Project sheet</h2>
		</div>
		<div class="table-wrap">
			<table class="matrix">
				<tbody>
					<tr><td><strong>License</strong></td><td>GPL-2.0</td></tr>
					<tr><td><strong>Maintainer</strong></td><td>Skyphusion Labs</td></tr>
					<tr><td><strong>Paths</strong></td><td>b-dosql (SQLite in a Durable Object); approach A (MySQL through Hyperdrive)</td></tr>
					<tr><td><strong>Rename</strong></td><td>Before 2026-11-13 the repository was wordpress-on-cloudflare</td></tr>
					<tr><td><strong>Source</strong></td><td><a href="https://github.com/skyphusion-labs/pagefeather">github.com/skyphusion-labs/pagefeather</a></td></tr>
				</tbody>
			</table>
		</div>
	</section>

	<section class="cta-band reveal">
		<div>
			<h2>Contribute</h2>
			<p>Start with the README, then the guide index under docs/guide/.</p>
		</div>
		<a class="btn btn--primary" href="https://github.com/skyphusion-labs/pagefeather" rel="noopener noreferrer">GitHub <span class="btn-arrow" aria-hidden="true">→</span></a>
	</section>
</main>
<?php
get_footer();
