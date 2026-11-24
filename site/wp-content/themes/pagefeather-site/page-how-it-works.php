<?php
/**
 * How it works.
 *
 * @package Pagefeather_Site
 */
get_header();
?>
<main id="main" class="shell">
	<div class="page-hero reveal">
		<p class="hero-eyebrow">Architecture</p>
		<h1>How it <em>works</em></h1>
		<p class="lede">Pagefeather is a framework. Your Cloudflare account runs the site. The code lives in the public repository. You keep the tokens, the data, and the bill.</p>
	</div>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">b-dosql</p>
			<h2>Built-in database</h2>
			<p class="section-intro">PHP and its SQLite database run in one Durable Object. One command deploys a site to workers.dev, or to a hostname in a zone you own.</p>
		</div>
		<div class="card-grid">
			<article class="card">
				<div class="card-meta"><span class="pill pill--teal">Deploy</span></div>
				<h3>One object per site</h3>
				<ul>
					<li><code class="inline-code">VARIANT=b-dosql</code> with <code class="inline-code">deploy/deploy.sh</code></li>
					<li>Workers Free or Workers Paid</li>
					<li><code class="inline-code">MEDIA=1</code> puts uploads in R2</li>
					<li>One writer, one region</li>
				</ul>
			</article>
			<article class="card">
				<div class="card-meta"><span class="pill pill--amber">Throughput</span></div>
				<h3>Uncached work</h3>
				<ul>
					<li>About 5 requests a second for work the cache cannot answer</li>
					<li>Past that the queue grows</li>
					<li>Near 100 clients the object refuses</li>
					<li>Evidence in <code class="inline-code">docs/perf-dosql.md</code></li>
				</ul>
			</article>
		</div>
	</section>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">Approach A</p>
			<h2>MySQL through Hyperdrive</h2>
			<p class="section-intro">PHP runs in a Worker. MySQL sits outside Cloudflare. Hyperdrive holds the connection pool. Placement should match the database region.</p>
		</div>
		<div class="card-grid">
			<article class="card">
				<div class="card-meta"><span class="pill pill--violet">Paid</span></div>
				<h3>What you need</h3>
				<ul>
					<li>Workers Paid (Free installer stops at the CPU limit)</li>
					<li><code class="inline-code">MYSQL=external</code> or <code class="inline-code">MYSQL=vultr</code></li>
					<li>Required <code class="inline-code">PLACEMENT</code> (for example <code class="inline-code">azure:westus2</code>)</li>
					<li>You also pay for the MySQL server</li>
				</ul>
			</article>
			<article class="card">
				<div class="card-meta"><span class="pill pill--green">Scale-out</span></div>
				<h3>Isolates</h3>
				<ul>
					<li>Isolates scale out under concurrency</li>
					<li>At 50 concurrent users, Cloudflare started up to 118 isolates</li>
					<li>Cold first request: 3 to 9&nbsp;s more at the client</li>
					<li>Ledger: results.md, 2026-11-09</li>
				</ul>
			</article>
		</div>
	</section>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">Many sites</p>
			<h2>Workers for Platforms</h2>
		</div>
		<div class="prose">
			<p>One platform Worker serves many sites. Each site is a named user Worker plus its own storage. <code class="inline-code">deploy/wfp/site</code> is the operator surface. Plan cost at rest is $30 a month for two or more sites (WfP Paid plus Workers Paid).</p>
		</div>
	</section>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">Cache</p>
			<h2>Guest pages at the edge</h2>
		</div>
		<div class="prose">
			<ul>
				<li>Logged-out guest pages can come from the Workers Cache and never reach PHP.</li>
				<li>Default guest TTL is 120&nbsp;s (<code class="inline-code">PAGE_CACHE_TTL</code>).</li>
				<li>Product, shop, and category pages default to 30&nbsp;s (<code class="inline-code">PAGE_CACHE_PRODUCT_TTL</code>).</li>
				<li>Cart, checkout, account, and logged-in pages always run PHP.</li>
				<li>A cached product page can show an old stock number for a short window. Checkout always reads real stock.</li>
			</ul>
		</div>
	</section>

	<section class="cta-band reveal">
		<div>
			<h2>Ready to install?</h2>
			<p>Use the checked Start here path on your own account.</p>
		</div>
		<a class="btn btn--primary" href="/get-started/">Get started <span class="btn-arrow" aria-hidden="true">→</span></a>
	</section>
</main>
<?php
get_footer();
