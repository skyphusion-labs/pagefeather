// #1098: a new install takes the site title from SITE_TITLE, else the site name, else the hostname.
// An installed site is not touched: blogname stays whatever the owner set in WordPress.
//   node --test spikes/b2-wordpress/tests/install-title.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const indexSrc = readFileSync(join(here, '..', 'index.js'), 'utf8');
const install = indexSrc.slice(indexSrc.indexOf('const INSTALL = `'), indexSrc.indexOf('const site = {'));
const installHandler = indexSrc.slice(indexSrc.indexOf("if (url.pathname === '/_install') {"), indexSrc.indexOf('return Response.json({ bootMs', indexSrc.indexOf("if (url.pathname === '/_install') {")));

test('#1098 an install with no title gives the site name, and one with a title gives that title', async () => {
	const { installSiteTitle, hostFromOrigin } = await import('../install-title.mjs');
	assert.equal(
		installSiteTitle({ title: '', siteName: 'cf759hx', host: 'wp-cf759hx.sub.workers.dev' }),
		'cf759hx',
	);
	assert.equal(
		installSiteTitle({ title: '   ', siteName: 'mystore', host: 'mystore.example' }),
		'mystore',
	);
	assert.equal(
		installSiteTitle({ title: 'North Shop', siteName: 'cf759hx', host: 'wp-cf759hx.sub.workers.dev' }),
		'North Shop',
	);
	assert.equal(installSiteTitle({ title: '', siteName: '', host: 'shop.example.co' }), 'shop.example.co');
	assert.equal(installSiteTitle({ title: '', siteName: '', host: 'localhost' }), 'localhost');
	assert.equal(installSiteTitle({}), '');
	assert.equal(hostFromOrigin('https://internal'), '');
	assert.equal(hostFromOrigin('http://127.0.0.1:8787'), '127.0.0.1');
	assert.notEqual(installSiteTitle({ siteName: 'cf759hx', host: 'wp-cf759hx.sub.workers.dev' }), 'WordPress on D1');
});

test('#1098 INSTALL uses that title and does not hard-code the old project name', () => {
	assert.equal(install.includes('WordPress on D1'), false);
	assert.match(install, /\/tmp\/site-title/);
	assert.match(install, /wp_install\(\s*\$title,/);
	assert.match(install, /is_blog_installed\(\)/);
	const already = install.indexOf('is_blog_installed()');
	const call = install.indexOf('wp_install(');
	assert.ok(already !== -1 && call !== -1 && already < call, 'an installed site returns before wp_install');
	assert.equal(install.includes("update_option( 'blogname'"), false);
});

test('#1098 /_install passes SITE_TITLE, the site name, and the origin host', () => {
	assert.match(installHandler, /installSiteTitle/);
	assert.match(installHandler, /x-site-title/);
	assert.match(installHandler, /env\.SITE_TITLE/);
	assert.match(installHandler, /x-site-name/);
	assert.match(installHandler, /env\.SITE_NAME/);
	assert.match(installHandler, /hostFromOrigin\(env\.SITE_ORIGIN\)/);
	assert.match(installHandler, /hostFromOrigin\(url\.origin\)/);
	assert.match(installHandler, /\/tmp\/site-title/);
});

test('#1098 each variant can carry the site name, and SITE_TITLE is a recorded setting', () => {
	const lib = readFileSync(join(root, 'deploy/wfp/lib.sh'), 'utf8');
	const settings = readFileSync(join(root, 'deploy/wfp/site_settings.py'), 'utf8');
	const site = readFileSync(join(root, 'deploy/wfp/site'), 'utf8');
	const render = readFileSync(join(root, 'deploy/render-conf.sh'), 'utf8');
	const recorded = readFileSync(join(root, 'deploy/lib/recorded-inputs.sh'), 'utf8');
	const wp = readFileSync(join(root, 'deploy/provision/wp-site-config.mjs'), 'utf8');
	const server = readFileSync(join(root, 'deploy/provision/server-config.mjs'), 'utf8');
	const ops = readFileSync(join(root, 'deploy/provision/ops.mjs'), 'utf8');
	const provision = readFileSync(join(root, 'deploy/provision/provision.mjs'), 'utf8');
	const deploySh = readFileSync(join(root, 'deploy/deploy.sh'), 'utf8');
	const vendorServer = readFileSync(join(root, 'deploy/oneclick/vendor/provision/server-config.mjs'), 'utf8');
	const vendorOps = readFileSync(join(root, 'deploy/oneclick/vendor/provision/ops.mjs'), 'utf8');
	assert.match(lib, /SITE_NAME = "\$s"/);
	assert.match(lib, /SITE_TITLE/);
	assert.match(settings, /"SITE_TITLE"/);
	assert.match(site, /SITE_TITLE="\$\{SITE_TITLE:-\}"/);
	assert.match(render, /SITE_NAME/);
	assert.match(render, /SITE_TITLE/);
	assert.match(recorded, /SITE_TITLE/);
	assert.match(wp, /SITE_NAME/);
	assert.match(wp, /SITE_TITLE/);
	assert.match(server, /siteName: name/);
	assert.match(ops, /x-site-title/);
	assert.match(ops, /x-site-name/);
	assert.match(ops, /\\u0000-\\u001F/);
	assert.match(provision, /siteName: cfg\.name/);
	assert.match(vendorServer, /siteName: name/);
	assert.match(vendorOps, /x-site-name/);
	const early = deploySh.indexOf('install-title.mjs');
	const recordedAt = deploySh.indexOf('inputs_check');
	assert.ok(early !== -1 && recordedAt !== -1 && early < recordedAt, 'deploy.sh checks SITE_TITLE before it records inputs');
});

test('#1098 SITE_TITLE toml line escapes a quote and refuses a control character', () => {
	const bin = join(here, '..', 'install-title.mjs');
	const ok = spawnSync(process.execPath, [bin, '--toml'], { env: { ...process.env, SITE_TITLE: 'North "Shop"' } });
	assert.equal(ok.status, 0);
	assert.equal(ok.stdout.toString(), 'SITE_TITLE = "North \\"Shop\\""\n');
	const bad = spawnSync(process.execPath, [bin, '--toml'], { env: { ...process.env, SITE_TITLE: 'a\nb' } });
	assert.equal(bad.status, 1);
	assert.match(bad.stderr.toString(), /SITE_TITLE must be one line/);
});
