// #1195: $_SERVER['PHP_SELF'] on a path served by the front controller. Stock Apache and nginx give
// SCRIPT_NAME . PATH_INFO (/index.php). php-wasm's request handler gives the requested path when its
// file-not-found action redirects internally to /index.php. Core's WP::parse_request then reads an unmatched path as
// "a request for ourself", clears the 404 and runs the home query: /cart/x/y/z answered 301 then the home page with 200.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PHPRequestHandler } from '@php-wasm/universal';
import { installPhpSelf } from '../php-self.mjs';

// A fake runtime with the real handler in front: the files that exist, and every runStream request recorded.
function fakeHandler(files, install) {
	const seen = [];
	const php = {
		requestHandler: null,
		isFile: (p) => files.includes(p),
		isDir: (p) => files.some((f) => f.startsWith(p.replace(/\/+$/, '') + '/')),
		fileExists: (p) => files.includes(p),
		readFileAsBuffer: () => new Uint8Array(),
		chdir: () => {},
		runStream: async (request) => {
			seen.push(request);
			throw new Error('recorded');
		},
	};
	if (install) installPhpSelf(php);
	const handler = new PHPRequestHandler({
		php,
		documentRoot: '/wordpress',
		absoluteUrl: 'http://site.test',
		cookieStore: false,
		getFileNotFoundAction: () => ({ type: 'internal-redirect', uri: '/index.php' }),
	});
	return { handler, seen };
}
const FILES = ['/wordpress/index.php', '/wordpress/wp-login.php', '/wordpress/wp-admin/index.php'];
async function serverFor(url, install) {
	const { handler, seen } = fakeHandler(FILES, install);
	await handler.request({ url }).catch(() => {});
	assert.equal(seen.length, 1, `the handler ran PHP for ${url}`);
	return seen[0].$_SERVER;
}

test('#1195 the INPUT: php-wasm alone sets PHP_SELF to the requested path on an internal redirect', async () => {
	const s = await serverFor('/cart/undefinedwc/store/v1/cart', false);
	assert.equal(s.SCRIPT_NAME, '/index.php');
	assert.equal(s.PHP_SELF, '/cart/undefinedwc/store/v1/cart', 'the library behaviour this fix corrects');
});

test('#1195 PHP_SELF is SCRIPT_NAME . PATH_INFO, as stock front controllers set it', async () => {
	for (const [url, self] of [
		['/cart/undefinedwc/store/v1/cart', '/index.php'],
		['/sample-page/', '/index.php'],
		['/?p=1', '/index.php'],
		['/wp-login.php?action=lostpassword', '/wp-login.php'],
		['/wp-admin/', '/wp-admin/index.php'],
		['/index.php/feed/', '/index.php/feed/'],
	]) {
		const s = await serverFor(url, true);
		assert.equal(s.PHP_SELF, self, url);
	}
});

test('#1195 installPhpSelf leaves other $_SERVER entries and a request without $_SERVER alone, and installs once', async () => {
	const seen = [];
	const php = { runStream: async (r) => (seen.push(r), 'ok') };
	installPhpSelf(php);
	installPhpSelf(php);
	assert.equal(await php.runStream({ code: '<?php' }), 'ok');
	assert.equal(seen[0].$_SERVER, undefined);
	await php.runStream({ $_SERVER: { SCRIPT_NAME: '/index.php', PHP_SELF: '/x/y', REQUEST_URI: '/x/y', HTTP_X: '1' } });
	assert.deepEqual(seen[1].$_SERVER, { SCRIPT_NAME: '/index.php', PHP_SELF: '/index.php', REQUEST_URI: '/x/y', HTTP_X: '1' });
	await php.runStream({ $_SERVER: { PHP_SELF: '/x' } });
	assert.deepEqual(seen[2].$_SERVER, { PHP_SELF: '/x' }, 'no SCRIPT_NAME: untouched');
});

test('#1195 index.js installs it on the one runtime, before the request handler', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.equal(src.split('installPhpSelf(php);').length - 1, 1, 'one install');
	assert.ok(src.indexOf('installPhpSelf(php);') < src.indexOf('const handler = new PHPRequestHandler({'), 'before the handler');
	assert.match(src, /import \{ installPhpSelf \} from '\.\/php-self\.mjs';/);
});
