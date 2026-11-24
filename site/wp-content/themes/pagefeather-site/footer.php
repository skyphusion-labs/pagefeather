<?php
/**
 * Site footer.
 *
 * @package Pagefeather_Site
 */
if (!defined('ABSPATH')) {
	exit;
}
?>
<footer class="site-footer">
	<div>
		<strong style="color:var(--fg);font-weight:600;">Pagefeather</strong>
		<span> · GPL-2.0 · Skyphusion Labs</span>
		<p style="margin:0.4rem 0 0;max-width:36rem;">You run it in your own Cloudflare account. There is no hosted product and no upsell.</p>
	</div>
	<div class="footer-links">
		<a href="/how-it-works/">How it works</a>
		<a href="/limits/">Limits</a>
		<a href="/get-started/">Get started</a>
		<a href="/evidence/">Evidence</a>
		<a href="https://github.com/skyphusion-labs/pagefeather" rel="noopener noreferrer">GitHub</a>
		<a href="https://ggc.sh" rel="noopener noreferrer">Live store</a>
	</div>
</footer>
<?php wp_footer(); ?>
</body>
</html>
