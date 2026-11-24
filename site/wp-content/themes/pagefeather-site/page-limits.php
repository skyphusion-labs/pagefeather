<?php
/**
 * Limits.
 *
 * @package Pagefeather_Site
 */
get_header();
?>
<main id="main" class="shell">
	<div class="page-hero reveal">
		<p class="hero-eyebrow">Product truth</p>
		<h1>Limits you should <em>know</em></h1>
		<p class="lede">Friendly never means selling. These limits sit next to every capability. Read them before you design a store around this stack.</p>
	</div>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">b-dosql</p>
			<h2>Built-in database walls</h2>
		</div>
		<div class="card-grid">
			<article class="card">
				<div class="card-meta"><span class="pill pill--teal">Throughput</span></div>
				<h3>One Durable Object</h3>
				<p>One writer and one region. About 5 uncached requests a second. Near 100 clients the object refuses.</p>
			</article>
			<article class="card">
				<div class="card-meta"><span class="pill pill--rose">#1022</span></div>
				<h3>Woo under load</h3>
				<p>Light storefront only. Isolate resets and lost writes under load. A real store uses approach A on Hyperdrive.</p>
			</article>
			<article class="card">
				<div class="card-meta"><span class="pill pill--amber">Bundle</span></div>
				<h3>Plugin size</h3>
				<p>Upload gate is 62&nbsp;MiB uncompressed. WooCommerce alone is about 58.3&nbsp;MiB. Some large plugins do not fit.</p>
			</article>
			<article class="card">
				<div class="card-meta"><span class="pill pill--violet">Memory</span></div>
				<h3>How many plugins fit</h3>
				<p>A per-request memory limit on heavy admin pages. Plan for it before you stack the suite.</p>
			</article>
		</div>
	</section>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">Approach A</p>
			<h2>MySQL path walls</h2>
		</div>
		<div class="table-wrap">
			<table class="matrix">
				<thead>
					<tr><th>Topic</th><th>What you see</th><th>Issue</th></tr>
				</thead>
				<tbody>
					<tr><td><strong>Cold isolate</strong></td><td>First request costs 3 to 9&nbsp;s more at the client</td><td>#1169</td></tr>
					<tr><td><strong>Checkout</strong></td><td>Mostly database time; about 5 to 7&nbsp;s after transient batching</td><td>#1210</td></tr>
					<tr><td><strong>Admin edits</strong></td><td>Product saves take seconds, not fractions of a second</td><td>#1078</td></tr>
					<tr><td><strong>Cache MISS</strong></td><td>Uncached guest product page can be slow far from the DB</td><td>#1277</td></tr>
					<tr><td><strong>Query bound</strong></td><td>One MySQL query may take at most 30&nbsp;s by default</td><td>#1359</td></tr>
					<tr><td><strong>Docs gap</strong></td><td>Step-by-step MySQL start page still open; use onboarding today</td><td>#1365</td></tr>
				</tbody>
			</table>
		</div>
	</section>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">Plans</p>
			<h2>What each plan buys</h2>
		</div>
		<div class="card-grid card-grid--3">
			<article class="card">
				<div class="card-meta"><span class="pill pill--green">Free</span></div>
				<h3>Workers Free</h3>
				<p>b-dosql WordPress and a light shop. Approach A installer is refused. Editing a WooCommerce store does not fit Free memory.</p>
			</article>
			<article class="card">
				<div class="card-meta"><span class="pill pill--teal">$5/mo</span></div>
				<h3>Workers Paid</h3>
				<p>$5 a month for Workers. Approach A also needs your MySQL bill. A <code class="inline-code">MYSQL=vultr</code> box is $10 a month.</p>
			</article>
			<article class="card">
				<div class="card-meta"><span class="pill pill--amber">$30/mo</span></div>
				<h3>Workers for Platforms</h3>
				<p>$30 a month at rest for two or more sites (WfP Paid $25 plus Workers Paid $5).</p>
			</article>
		</div>
		<p class="prose" style="margin-top:1.25rem;">
			Full tables with Cloudflare source links live in
			<a href="https://github.com/skyphusion-labs/pagefeather/blob/main/docs/guide/cost.md">docs/guide/cost.md</a>
			and
			<a href="https://github.com/skyphusion-labs/pagefeather/blob/main/docs/guide/limits.md">docs/guide/limits.md</a>.
		</p>
	</section>

	<section class="cta-band reveal">
		<div>
			<h2>Still a fit?</h2>
			<p>If the limits match your site, install on your own account.</p>
		</div>
		<a class="btn btn--primary" href="/get-started/">Get started <span class="btn-arrow" aria-hidden="true">→</span></a>
	</section>
</main>
<?php
get_footer();
