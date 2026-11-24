<?php
/**
 * Evidence.
 *
 * @package Pagefeather_Site
 */
get_header();
?>
<main id="main" class="shell">
	<div class="page-hero reveal">
		<p class="hero-eyebrow">Ledger</p>
		<h1>Evidence, not <em>claims</em></h1>
		<p class="lede">A result is measured only after a real deploy on that plan and a test. A documentation page alone is not a measurement. A third-party claim is not a measurement.</p>
	</div>

	<section class="reveal">
		<blockquote class="quote">
			Conformance comes before performance. The upstream WordPress, WooCommerce, and Gutenberg test suites decide what works means.
			<cite>docs/conformance.md</cite>
		</blockquote>
		<div class="prose" style="margin-top:1.5rem;">
			<p>The ledger is <a href="https://github.com/skyphusion-labs/pagefeather/blob/main/docs/results.md">docs/results.md</a>. Each row is one deploy and one test run. A failed deploy stays in the table. A later row may correct an earlier row. The earlier row stays.</p>
		</div>
	</section>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">Cited here</p>
			<h2>Figures on this site</h2>
		</div>
		<div class="table-wrap">
			<table class="matrix">
				<thead>
					<tr><th>Claim</th><th>Where</th></tr>
				</thead>
				<tbody>
					<tr><td><strong>Cached guests about 26 to 30 req/s</strong>, p50 near 200&nbsp;ms</td><td>docs/load-152.md · 2026-11-08</td></tr>
					<tr><td><strong>b-dosql ~5 uncached req/s</strong>; refuse near 100 clients</td><td>docs/perf-dosql.md</td></tr>
					<tr><td><strong>43 resets / 49 lost writes</strong> per 1000 server requests</td><td>cf759a · 2026-11-22 · #1022</td></tr>
					<tr><td><strong>wp 18/18</strong>; routes.py 0 failures</td><td>cf759hw · 2026-11-20</td></tr>
					<tr><td><strong>woo.py 12/12</strong>, three runs</td><td>results.md · 2026-11-09</td></tr>
					<tr><td><strong>Up to 118 isolates</strong> at 50 concurrent users</td><td>results.md · 2026-11-09</td></tr>
					<tr><td><strong>Fresh-clone Pass</strong> for b-dosql, WfP, approach A</td><td>results.md · 2026-11-24</td></tr>
					<tr><td><strong>Workers Paid $5/mo</strong>; WfP path $30/mo at rest</td><td>docs/guide/cost.md · read 2026-11-06</td></tr>
				</tbody>
			</table>
		</div>
	</section>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">Live</p>
			<h2>Examples you can open</h2>
		</div>
		<div class="card-grid">
			<article class="card">
				<div class="card-meta"><span class="pill pill--amber">Store</span></div>
				<h3>ggc.sh</h3>
				<p>WooCommerce on this framework. Guest storefront can be cached. Cart, checkout, account, and logged-in pages always run PHP.</p>
				<a class="card-link" href="https://ggc.sh" rel="noopener noreferrer">Open ggc.sh <span aria-hidden="true">→</span></a>
			</article>
			<article class="card">
				<div class="card-meta"><span class="pill pill--teal">Marketing</span></div>
				<h3>www.pagefeather.dev</h3>
				<p>This site. b-dosql WordPress on Workers Paid. <code class="inline-code">MEDIA=1</code>. WooCommerce off. Apex redirects here.</p>
				<a class="card-link" href="/">Home <span aria-hidden="true">→</span></a>
			</article>
		</div>
	</section>

	<section class="cta-band reveal">
		<div>
			<h2>Read the raw ledger</h2>
			<p>Every plan, date, Wrangler version, command, and result.</p>
		</div>
		<a class="btn btn--primary" href="https://github.com/skyphusion-labs/pagefeather/blob/main/docs/results.md" rel="noopener noreferrer">results.md <span class="btn-arrow" aria-hidden="true">→</span></a>
	</section>
</main>
<?php
get_footer();
