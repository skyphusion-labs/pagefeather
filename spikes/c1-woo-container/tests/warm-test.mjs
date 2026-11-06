// Tests of warm.js (issue #73). Run: node spikes/c1-woo-container/tests/warm-test.mjs
// The package is commonjs, so warm.js is copied to a temporary .mjs first.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'warm.js'), 'utf8');
const tmpDir = mkdtempSync(join(tmpdir(), 'warm-'));
const tmp = join(tmpDir, 'warm.mjs');
writeFileSync(tmp, src);
const w = await import(tmp);
rmSync(tmpDir, { recursive: true, force: true });
let fails = 0;
const check = (name, got, want) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) fails++;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};
const u = (p) => new URL('https://shop.example' + p);

// Product views.
const views = ['/product/blue-shirt/', '/product/x', '/shop', '/shop/', '/shop/page/2/', '/product-category/shirts/', '/product-tag/sale/', '/?product=blue-shirt', '/?post_type=product&p=12'];
const notViews = ['/', '/cart/', '/checkout/', '/shopping/', '/products-we-love/', '/about/', '/?p=1', '/wp-json/wc/store/v1/cart'];
check('product views', views.map((p) => w.isProductView(u(p))), views.map(() => true));
check('not product views', notViews.map((p) => w.isProductView(u(p))), notViews.map(() => false));
check('WARM_PATHS replaces the default', [w.isProductView(u('/item/x'), '^/item/'), w.isProductView(u('/product/x'), '^/item/')], [true, false]);
check('a bad WARM_PATHS falls back to the default', w.isProductView(u('/product/x'), '(unclosed'), true);

// The gateway: off by default, once per gap.
w.resetGatewayForTests();
check('gateway: off by default', [w.gatewayMayWarm({}, 1000), w.gatewayMayWarm({ WARM_START: 'off' }, 1000)], [false, false]);
const on = { WARM_START: 'product', WARM_GAP_S: '60' };
w.resetGatewayForTests();
check('gateway: first view asks, then not within the gap, then again after it', [w.gatewayMayWarm(on, 1000), w.gatewayMayWarm(on, 30000), w.gatewayMayWarm(on, 61001)], [true, false, true]);
w.resetGatewayForTests();
check('gateway: WARM_GAP_S=0 asks every time', [w.gatewayMayWarm({ WARM_START: 'product', WARM_GAP_S: '0' }, 1), w.gatewayMayWarm({ WARM_START: 'product', WARM_GAP_S: '0' }, 2)], [true, true]);

// The object.
function fakeStore({ running = false, fail = false } = {}) {
	const o = { env: { WARM_GAP_S: '60' }, ctx: { container: { running } }, starts: 0 };
	o.start = async () => {
		o.starts++;
		if (fail) throw new Error('no capacity');
	};
	return o;
}
let s = fakeStore({ running: true });
check('object: a running container is not started', [await w.warmStart(s, 1000), s.starts, s.warm.skipped_running], [{ started: false, reason: 'running' }, 0, 1]);
s = fakeStore();
const r1 = await w.warmStart(s, 1000);
const r2 = await w.warmStart(s, 30000);
const r3 = await w.warmStart(s, 61001);
check('object: start, then not within the gap, then again', [r1.started, r2.reason, r3.started, s.starts, s.warm.skipped_gap], [true, 'gap', true, 2, 1]);
s = fakeStore({ fail: true });
check('object: a failed start is counted, not thrown', [await w.warmStart(s, 1000), s.warm.failed], [{ started: false, reason: 'error', error: 'no capacity' }, 1]);
check('info', w.warmInfo(fakeStore(), { WARM_START: 'product', WARM_GAP_S: '30' }), { mode: 'product', gap_s: 30, starts: 0, skipped_running: 0, skipped_gap: 0, failed: 0, last_ms_ago: null, last_error: null });

// Never through fetch (the bounded queue of #39 counts fetch): warm.js has no
// fetch call, and Store.prototype.fetch in worker.js does not warm.
const worker = readFileSync(join(here, '..', 'worker.js'), 'utf8');
check('warm.js makes no fetch', /\.fetch\(|\bfetch\(/.test(src), false);
const fetchBody = worker.slice(worker.indexOf('Store.prototype.fetch = async function'), worker.indexOf('};', worker.indexOf('Store.prototype.fetch = async function')));
check('Store.prototype.fetch does not warm', /warm/i.test(fetchBody), false);
const cacheable = worker.slice(worker.indexOf('if (storefrontCacheable(req, url)) {'), worker.indexOf('return ctx.exports.Storefront.fetch', worker.indexOf('if (storefrontCacheable(req, url)) {')));
check('the gateway warms in the cacheable branch, after the response (waitUntil)', /isProductView\(url, env\.WARM_PATHS\) && gatewayMayWarm\(env\)\) ctx\.waitUntil\(store\(env\)\.warmStart\(\)/.test(cacheable), true);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
