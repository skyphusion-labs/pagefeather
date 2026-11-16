// node --test spikes/b2-wordpress/tests/php-auth.test.mjs (#761)
// Authorization: Basic becomes PHP_AUTH_USER and PHP_AUTH_PW, as Apache with
// mod_php does. A Bearer header, bad base64, or a value with no colon sets
// nothing and does not throw. The header and the decoded values are never logged.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { applyPhpBasicAuth, installPhpBasicAuth, phpBasicAuthEntries } from '../php-auth.mjs';

const USER = 'ada';
const PASS = 'p:a:ss';
const HEADER = 'Basic ' + btoa(USER + ':' + PASS);

function captureConsole(fn) {
	const logs = [];
	const orig = {};
	for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
		orig[method] = console[method];
		console[method] = (...args) => {
			logs.push(args.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
		};
	}
	try {
		const result = fn();
		return { result, logs };
	} finally {
		for (const method of Object.keys(orig)) console[method] = orig[method];
	}
}

function assertNoCredentials(text) {
	assert.equal(text.includes(USER), false, 'user logged');
	assert.equal(text.includes(PASS), false, 'password logged');
	assert.equal(text.includes(HEADER), false, 'header logged');
	assert.equal(text.includes(btoa(USER + ':' + PASS)), false, 'token logged');
}

test('a Basic header sets PHP_AUTH_USER and PHP_AUTH_PW', () => {
	const got = phpBasicAuthEntries({ authorization: HEADER });
	assert.deepEqual(got, { PHP_AUTH_USER: USER, PHP_AUTH_PW: PASS });
	const titled = phpBasicAuthEntries({ Authorization: 'BASIC ' + btoa(USER + ':' + PASS) });
	assert.deepEqual(titled, { PHP_AUTH_USER: USER, PHP_AUTH_PW: PASS });
	const headers = new Headers();
	headers.set('Authorization', HEADER);
	assert.deepEqual(phpBasicAuthEntries(headers), { PHP_AUTH_USER: USER, PHP_AUTH_PW: PASS });
});

test('a password with colons survives the first-colon split', () => {
	const pass = 'one:two:three';
	const got = phpBasicAuthEntries({ authorization: 'Basic ' + btoa('ada:' + pass) });
	assert.equal(got.PHP_AUTH_USER, 'ada');
	assert.equal(got.PHP_AUTH_PW, pass);
});

test('an empty user or an empty password is still set', () => {
	assert.deepEqual(phpBasicAuthEntries({ authorization: 'Basic ' + btoa(':secret') }), { PHP_AUTH_USER: '', PHP_AUTH_PW: 'secret' });
	assert.deepEqual(phpBasicAuthEntries({ authorization: 'Basic ' + btoa('ada:') }), { PHP_AUTH_USER: 'ada', PHP_AUTH_PW: '' });
});

test('a Bearer header sets nothing', () => {
	assert.equal(phpBasicAuthEntries({ authorization: 'Bearer tok.not.basic' }), null);
	assert.equal(phpBasicAuthEntries({ authorization: 'Digest username="ada"' }), null);
	const request = { headers: { authorization: 'Bearer tok.not.basic' }, $_SERVER: { HTTPS: 'on' } };
	assert.equal(applyPhpBasicAuth(request), request);
	assert.equal(request.$_SERVER.PHP_AUTH_USER, undefined);
	assert.equal(request.$_SERVER.PHP_AUTH_PW, undefined);
});

test('malformed base64 or a value with no colon sets nothing and does not throw', () => {
	const bad = ['Basic !!!', 'Basic @@@@', 'Basic ab', 'Basic', 'Basic ', 'nocolon', btoa('nocolon'), ''];
	assert.doesNotThrow(() => {
		for (const value of bad) assert.equal(phpBasicAuthEntries({ authorization: value }), null, value);
		assert.equal(phpBasicAuthEntries({ authorization: 'Basic ' + btoa('nocolon') }), null);
		assert.equal(phpBasicAuthEntries(null), null);
		assert.equal(phpBasicAuthEntries(undefined), null);
		assert.equal(phpBasicAuthEntries(7), null);
		assert.equal(phpBasicAuthEntries({ authorization: 7 }), null);
		assert.equal(phpBasicAuthEntries({ authorization: ['Basic ' + btoa('ada:x')] }), null);
		assert.equal(applyPhpBasicAuth(null), null);
		assert.equal(applyPhpBasicAuth('nope'), 'nope');
		installPhpBasicAuth(null);
		installPhpBasicAuth({});
	});
});

test('the header stays on the request, and earlier $_SERVER entries stay', () => {
	const request = applyPhpBasicAuth({ method: 'GET', headers: { authorization: HEADER, host: 'shop.test' }, $_SERVER: { HTTPS: 'on', REQUEST_METHOD: 'GET' } });
	assert.equal(request.headers.authorization, HEADER);
	assert.equal(request.headers.host, 'shop.test');
	assert.equal(request.$_SERVER.HTTPS, 'on');
	assert.equal(request.$_SERVER.REQUEST_METHOD, 'GET');
	assert.equal(request.$_SERVER.PHP_AUTH_USER, USER);
	assert.equal(request.$_SERVER.PHP_AUTH_PW, PASS);
	assert.equal(request.method, 'GET');
});

test('the runtime wrapper sets the entries on the PHP run and keeps HTTP authorization', () => {
	const seen = [];
	const php = {
		runStream(request) {
			seen.push(request);
			return 'ran';
		},
	};
	installPhpBasicAuth(php);
	assert.equal(php.runStream({ method: 'GET', headers: { authorization: HEADER }, $_SERVER: { HTTPS: 'on' } }), 'ran');
	assert.equal(seen.length, 1);
	assert.equal(seen[0].headers.authorization, HEADER);
	assert.equal(seen[0].$_SERVER.HTTPS, 'on');
	assert.equal(seen[0].$_SERVER.PHP_AUTH_USER, USER);
	assert.equal(seen[0].$_SERVER.PHP_AUTH_PW, PASS);
	const bearer = { headers: { authorization: 'Bearer tok' }, $_SERVER: { HTTPS: 'on' } };
	php.runStream(bearer);
	assert.equal(seen[1], bearer);
	assert.equal(seen[1].$_SERVER.PHP_AUTH_USER, undefined);
	assert.equal(seen[1].$_SERVER.PHP_AUTH_PW, undefined);
});

test('no log line contains the credentials', () => {
	const { logs } = captureConsole(() => {
		phpBasicAuthEntries({ authorization: HEADER });
		phpBasicAuthEntries(new Headers({ authorization: HEADER }));
		applyPhpBasicAuth({ headers: { authorization: HEADER } });
		phpBasicAuthEntries({ authorization: 'Basic !!!' });
		phpBasicAuthEntries({ authorization: 'Bearer ' + PASS });
		const php = { runStream(request) { return request; } };
		installPhpBasicAuth(php);
		php.runStream({ headers: { authorization: HEADER } });
		php.runStream({ headers: { authorization: 'Basic !!!' } });
	});
	assertNoCredentials(logs.join('\n'));
});

test('the mapper source does not log, and boot installs it once before the request handler', () => {
	const mapper = readFileSync(new URL('../php-auth.mjs', import.meta.url), 'utf8');
	assert.equal(/console\s*\./.test(mapper), false, 'php-auth.mjs logs');
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const made = src.indexOf('const php = new PHP(id);');
	const installed = src.indexOf('installPhpBasicAuth(php);');
	const handlerAt = src.indexOf('const handler = new PHPRequestHandler({');
	const requestAt = src.indexOf('await handler.request({ url: url.pathname + url.search');
	assert.ok(made > 0, 'runtime construction');
	assert.ok(installed > made, 'install after the runtime exists');
	assert.ok(handlerAt > installed, 'install before the request handler');
	assert.ok(requestAt > handlerAt, 'the handler serves the request');
	assert.equal(src.split('installPhpBasicAuth(php);').length - 1, 1, 'one install for the object and the Worker');
	const around = src.slice(installed, installed + 400);
	assert.equal(/console\s*\./.test(around), false, 'the install site logs');
});
