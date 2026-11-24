<?php
/**
 * Home: brand-first marketing surface.
 *
 * @package Pagefeather_Site
 */
get_header();
$mark = get_template_directory_uri() . '/assets/img/mark.svg';
?>
<section class="hero">
	<div class="hero-core">
		<img class="hero-mark" src="<?php echo esc_url($mark); ?>" width="96" height="96" alt="Pagefeather">
		<p class="hero-eyebrow">Skyphusion Labs / open source</p>
		<h1>WordPress on Cloudflare.<br><em>In your account.</em></h1>
		<p class="hero-lede">Pagefeather runs WordPress and WooCommerce on Workers. You keep the tokens, the data, and the bill. There is no hosted funnel and no upsell.</p>
		<div class="hero-actions">
			<a class="btn btn--primary" href="/get-started/">Get started <span class="btn-arrow" aria-hidden="true">→</span></a>
			<a class="btn btn--ghost" href="/limits/">Read the limits</a>
			<a class="btn btn--ghost" href="https://github.com/skyphusion-labs/pagefeather" rel="noopener noreferrer">GitHub</a>
		</div>
		<dl class="hero-stats">
			<div class="stat"><dt>License</dt><dd>GPL-2.0</dd></div>
			<div class="stat"><dt>Price</dt><dd>$0</dd></div>
			<div class="stat"><dt>Hosted?</dt><dd>No</dd></div>
			<div class="stat"><dt>Paths</dt><dd>2</dd></div>
		</dl>
	</div>
</section>

<main id="main" class="shell">
	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">Two paths</p>
			<h2>Pick the database that fits the store</h2>
			<p class="section-intro">Both paths ship today. The built-in database path is simple. The MySQL path is for a real shop that must scale out.</p>
		</div>
		<div class="card-grid">
			<article class="card">
				<div class="card-meta">
					<span class="pill pill--teal">b-dosql</span>
					<span class="pill pill--green">Free or Paid</span>
				</div>
				<h3>Built-in database</h3>
				<p>PHP and SQLite live in one Durable Object. You need no MySQL server. Fits WordPress and a light storefront.</p>
				<ul>
					<li>One writer, one region per site</li>
					<li>About 5 uncached requests a second</li>
					<li>Guest pages can hit the edge cache</li>
				</ul>
				<a class="card-link" href="/how-it-works/">How b-dosql works <span aria-hidden="true">→</span></a>
			</article>
			<article class="card">
				<div class="card-meta">
					<span class="pill pill--amber">Approach A</span>
					<span class="pill pill--violet">Workers Paid</span>
				</div>
				<h3>MySQL through Hyperdrive</h3>
				<p>PHP runs in a Worker. MySQL sits outside Cloudflare. Hyperdrive holds the pool. This is the path for a real WooCommerce store.</p>
				<ul>
					<li>Scales out across isolates</li>
					<li>You also pay for the MySQL server</li>
					<li>Placement should match the database region</li>
				</ul>
				<a class="card-link" href="/how-it-works/">How approach A works <span aria-hidden="true">→</span></a>
			</article>
		</div>
	</section>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">Measured</p>
			<h2>What is solid today</h2>
			<p class="section-intro">A README cell is not a measurement. Each figure below has a deploy and a test row in the ledger.</p>
		</div>
		<blockquote class="quote">
			Cached guest reads ran about 26 to 30 requests a second per site, with a p50 near 200&nbsp;ms. That is a lower bound set by the test client.
			<cite>docs/load-152.md · 2026-11-08</cite>
		</blockquote>
		<div class="card-grid" style="margin-top:1rem;">
			<article class="card">
				<div class="card-meta"><span class="pill pill--green">Pass</span></div>
				<h3>Approach A conformance</h3>
				<p>WordPress wp suite 18 of 18. routes.py with 0 failures on <code class="inline-code">cf759hw</code>. WooCommerce <code class="inline-code">tests/woo.py</code> 12 of 12, three runs in a row.</p>
			</article>
			<article class="card">
				<div class="card-meta"><span class="pill pill--teal">Fresh clone</span></div>
				<h3>Install from a clean tree</h3>
				<p>b-dosql, Workers for Platforms, and approach A Pass from a fresh clone of main (results.md, 2026-11-24).</p>
			</article>
		</div>
		<p style="margin-top:1.25rem;"><a class="card-link" href="/evidence/">Open the evidence page <span aria-hidden="true">→</span></a></p>
	</section>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">Product truth</p>
			<h2>Where it stops</h2>
			<p class="section-intro">Friendly never means selling. Read these before you design a store around this stack.</p>
		</div>
		<div class="card-grid">
			<article class="card">
				<div class="card-meta"><span class="pill pill--rose">Tracked limit</span><span class="pill pill--amber">#1022</span></div>
				<h3>WooCommerce on b-dosql</h3>
				<p>A light storefront only. Under load the Durable Object isolate can reset and lose writes. Measured on <code class="inline-code">cf759a</code>: 43 resets and 49 lost writes per 1000 server requests. A real store uses approach A.</p>
			</article>
			<article class="card">
				<div class="card-meta"><span class="pill pill--amber">#1169</span><span class="pill pill--violet">Cold start</span></div>
				<h3>Approach A cold isolates</h3>
				<p>A first request on a cold isolate costs 3 to 9&nbsp;s more at the client. Checkout time is mostly database time today.</p>
			</article>
		</div>
		<p style="margin-top:1.25rem;"><a class="card-link" href="/limits/">Full limits list <span aria-hidden="true">→</span></a></p>
	</section>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">This site</p>
			<h2>A live b-dosql deploy</h2>
			<p class="section-intro"><code class="inline-code">www.pagefeather.dev</code> is itself WordPress on Workers Paid with the built-in database. Apex <code class="inline-code">pagefeather.dev</code> redirects here. Media is in R2. WooCommerce is off.</p>
		</div>
		<figure class="figure">
			<svg class="arch-svg" viewBox="0 0 980 280" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Architecture sketch: visitor to edge cache to Durable Object with SQLite, media in R2">
				<defs>
					<linearGradient id="ag" x1="0" y1="0" x2="1" y2="1">
						<stop stop-color="#2dd4bf"/><stop offset="1" stop-color="#fbbf24"/>
					</linearGradient>
				</defs>
				<rect width="980" height="280" rx="16" fill="#0c1220"/>
				<rect x="40" y="90" width="140" height="70" rx="10" fill="#111827" stroke="#1e2d45"/>
				<text x="110" y="130" text-anchor="middle" fill="#e8edf5" font-family="DM Sans, sans-serif" font-size="14">Visitor</text>
				<path d="M190 125h70" stroke="url(#ag)" stroke-width="2"/>
				<polygon points="260,125 250,120 250,130" fill="#2dd4bf"/>
				<rect x="270" y="70" width="180" height="110" rx="10" fill="#111827" stroke="#2dd4bf" stroke-opacity="0.45"/>
				<text x="360" y="115" text-anchor="middle" fill="#2dd4bf" font-family="JetBrains Mono, monospace" font-size="11">EDGE CACHE</text>
				<text x="360" y="138" text-anchor="middle" fill="#7b8da8" font-family="DM Sans, sans-serif" font-size="13">guest HIT</text>
				<path d="M450 125h60" stroke="#1e2d45" stroke-width="2" stroke-dasharray="4 4"/>
				<rect x="520" y="55" width="240" height="140" rx="12" fill="#111827" stroke="url(#ag)"/>
				<text x="640" y="100" text-anchor="middle" fill="#e8edf5" font-family="Instrument Serif, serif" font-size="20">Durable Object</text>
				<text x="640" y="128" text-anchor="middle" fill="#7b8da8" font-family="DM Sans, sans-serif" font-size="13">PHP + SQLite (b-dosql)</text>
				<text x="640" y="154" text-anchor="middle" fill="#4a5d78" font-family="JetBrains Mono, monospace" font-size="11">ONE WRITER · ONE REGION</text>
				<path d="M760 125h50" stroke="#1e2d45" stroke-width="2"/>
				<rect x="820" y="90" width="120" height="70" rx="10" fill="#111827" stroke="#fbbf24" stroke-opacity="0.5"/>
				<text x="880" y="130" text-anchor="middle" fill="#fbbf24" font-family="JetBrains Mono, monospace" font-size="12">R2 MEDIA</text>
			</svg>
			<figcaption>b-dosql sketch · this marketing site’s path</figcaption>
		</figure>
	</section>

	<section class="cta-band reveal">
		<div>
			<h2>Clone it. Deploy it.</h2>
			<p>One command builds WordPress on your Cloudflare account. Start with the checked path.</p>
		</div>
		<div class="hero-actions" style="margin:0;">
			<a class="btn btn--primary" href="/get-started/">Start here <span class="btn-arrow" aria-hidden="true">→</span></a>
			<a class="btn btn--ghost" href="https://ggc.sh" rel="noopener noreferrer">See a live store</a>
		</div>
	</section>
</main>
<?php
get_footer();
