// node --test spikes/b2-wordpress/tests/upload-scope.test.mjs
// GET /wp-content/uploads/<path> is served from R2 by serveUpload with no PHP and no login check. A stock install's web
// server refuses the upload folders WooCommerce writes "deny from all" into; this engine must refuse them too, to a
// guest and to anyone else, without reading R2.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { serveUpload, protectedUploadKey, PROTECTED_UPLOAD_DIRS } from '../upload-scope.mjs';

function fakeEnv() {
	const gets = [];
	return {
		gets,
		MEDIA: {
			async get(key) {
				gets.push(key);
				return { size: 3, httpEtag: '"e"', body: new Blob(['abc']).stream(), writeHttpMetadata(h) { h.set('content-type', 'image/png'); } };
			},
		},
	};
}
async function guestGet(path, method = 'GET') {
	const env = fakeEnv();
	const url = new URL('https://site.example' + path);
	const res = await serveUpload(new Request(url, { method }), env, url);
	return { status: res.status, gets: env.gets };
}

test('a guest GET of a file in a folder WooCommerce protects is refused, and R2 is never read', async () => {
	for (const p of [
		'/wp-content/uploads/woocommerce_uploads/2026/11/paid-download.zip',
		'/wp-content/uploads/woocommerce_uploads/reports/orders.csv',
		'/wp-content/uploads/wc-logs/fatal-errors-2026-11-23.log',
		'/wp-content/uploads/woocommerce_transient_files/2026-11-30/abc',
	]) {
		const r = await guestGet(p);
		assert.equal(r.status, 403, p);
		assert.deepEqual(r.gets, [], p + ': no R2 read');
	}
	assert.equal((await guestGet('/wp-content/uploads/woocommerce_uploads/2026/11/x.png', 'HEAD')).status, 403, 'HEAD too');
});
test('an encoded or doubled spelling of a protected folder is refused too', async () => {
	for (const p of [
		'/wp-content/uploads/woocommerce_uploads%2F2026%2F11%2Fx.png',
		'/wp-content/uploads/%2Fwoocommerce_uploads/x.png',
		'/wp-content/uploads/.%2Fwoocommerce_uploads/x.png',
		'/wp-content/uploads/WooCommerce_Uploads/x.png',
		'/wp-content/uploads/woocommerce%5Fuploads/x.png',
	]) assert.equal((await guestGet(p)).status, 403, p);
});
test('ordinary uploads are still served', async () => {
	for (const p of ['/wp-content/uploads/2026/11/photo.jpg', '/wp-content/uploads/product-feeds/feed.json', '/wp-content/uploads/woocommerce_uploads_public/x.png', '/wp-content/uploads/2026/11/woocommerce_uploads.png']) {
		const r = await guestGet(p);
		assert.equal(r.status, 200, p);
		assert.equal(r.gets.length, 1, p);
	}
});
test('the protected folders are the three WooCommerce denies', () => {
	assert.deepEqual([...PROTECTED_UPLOAD_DIRS].sort(), ['wc-logs', 'woocommerce_transient_files', 'woocommerce_uploads']);
	assert.equal(protectedUploadKey('uploads/woocommerce_uploads/a'), true);
	assert.equal(protectedUploadKey('uploads/2026/11/a'), false);
});
test('index.js serves uploads through this module, and nowhere else reads an uploads key for the web', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.ok(src.includes("import { serveUpload } from './upload-scope.mjs';"));
	assert.ok(!src.includes('async function serveUpload('), 'no second copy left in index.js');
});
