<?php
/**
 * Get started.
 *
 * @package Pagefeather_Site
 */
get_header();
?>
<main id="main" class="shell">
	<div class="page-hero reveal">
		<p class="hero-eyebrow">Install</p>
		<h1>Get <em>started</em></h1>
		<p class="lede">Use your own Cloudflare account. Clone the repository. Follow the checked path. There is no one-click installer for a single site yet (#401).</p>
	</div>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">Read first</p>
			<h2>Three pages before you build</h2>
		</div>
		<div class="card-grid card-grid--3">
			<article class="card">
				<div class="card-meta"><span class="pill pill--teal">1</span></div>
				<h3>Start here</h3>
				<p>Install, login, remove a site.</p>
				<a class="card-link" href="https://github.com/skyphusion-labs/pagefeather/blob/main/docs/guide/start-here.md">docs/guide/start-here.md <span aria-hidden="true">→</span></a>
			</article>
			<article class="card">
				<div class="card-meta"><span class="pill pill--amber">2</span></div>
				<h3>Limits</h3>
				<p>Open walls and plan costs.</p>
				<a class="card-link" href="/limits/">On this site <span aria-hidden="true">→</span></a>
			</article>
			<article class="card">
				<div class="card-meta"><span class="pill pill--violet">3</span></div>
				<h3>Plugins</h3>
				<p>Add, update, remove. Code-locked builds.</p>
				<a class="card-link" href="https://github.com/skyphusion-labs/pagefeather/blob/main/docs/guide/plugins-and-themes.md">plugins-and-themes.md <span aria-hidden="true">→</span></a>
			</article>
		</div>
	</section>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">One site</p>
			<h2>Built-in database</h2>
			<p class="section-intro">You need git, Node 22+, Terraform 1.5+, Python 3.11+, and a Cloudflare API token with Workers Scripts Edit, R2 Edit, and Account Settings Read.</p>
		</div>
		<div class="prose">
			<pre class="code-block"><code>git clone https://github.com/skyphusion-labs/pagefeather.git
cd pagefeather
export CLOUDFLARE_API_TOKEN=...
export ACCOUNT_ID=...
VARIANT=b-dosql MEDIA=1 BENCH=0 NAME=my-site ./deploy/deploy.sh</code></pre>
			<p>The script prints the site address. On our test machine (Linux, 4 CPUs) this took about 90 seconds.</p>
			<p><strong>Admin password</strong></p>
			<pre class="code-block"><code>cd deploy/terraform
terraform workspace select my-site
terraform output -raw admin_password</code></pre>
			<p>Keep that password safe. <code class="inline-code">deploy/terraform/terraform.tfstate.d/</code> holds site secrets. Do not share it or put it in git.</p>
		</div>
	</section>

	<section class="reveal">
		<div class="section-head">
			<p class="section-eyebrow">Also</p>
			<h2>Many sites and real stores</h2>
		</div>
		<div class="card-grid">
			<article class="card">
				<div class="card-meta"><span class="pill pill--amber">WfP</span></div>
				<h3>Many sites</h3>
				<pre class="code-block" style="margin-top:0.75rem;"><code>export SITES="blog"
./deploy/wfp/up.sh
./deploy/wfp/site add shop</code></pre>
				<p>Needs Workers for Platforms Paid. Operator flow in <code class="inline-code">docs/guide/operator.md</code>.</p>
			</article>
			<article class="card">
				<div class="card-meta"><span class="pill pill--violet">MySQL</span></div>
				<h3>Real store</h3>
				<pre class="code-block" style="margin-top:0.75rem;"><code>VARIANT=a MYSQL=external \
  MYSQL_HOST=mysql.example.com \
  MYSQL_USER=wp MYSQL_PASSWORD=... \
  MYSQL_DATABASE=wordpress \
  PLACEMENT=azure:westus2 \
  NAME=my-site ./deploy/deploy.sh</code></pre>
				<p>Step-by-step MySQL page is open (#1365). Use onboarding and the deploy reference today.</p>
			</article>
		</div>
	</section>

	<section class="cta-band reveal">
		<div>
			<h2>See it running</h2>
			<p>ggc.sh is a WooCommerce store on this framework. This marketing site is a b-dosql WordPress deploy.</p>
		</div>
		<div class="hero-actions" style="margin:0;">
			<a class="btn btn--primary" href="https://github.com/skyphusion-labs/pagefeather" rel="noopener noreferrer">Repository <span class="btn-arrow" aria-hidden="true">→</span></a>
			<a class="btn btn--ghost" href="https://ggc.sh" rel="noopener noreferrer">Live store</a>
		</div>
	</section>
</main>
<?php
get_footer();
