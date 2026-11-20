import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { collapsedSlashRedirect } from '../slash-path.mjs';
import { mayHaveWritten } from '../object-error.mjs';

const ORDERS = 'https://wp.example//wp-json/wc/v3/orders';
const COLLAPSED = 'https://wp.example/wp-json/wc/v3/orders';

test('a repeated slash redirects to one slash and keeps the query', () => {
	assert.equal(
		collapsedSlashRedirect('https://wp.example//checkout-link?products=abc'),
		'https://wp.example/checkout-link?products=abc'
	);
});

test('a normal path is left alone', () => {
	assert.equal(collapsedSlashRedirect('https://wp.example/checkout-link?products=abc'), null);
});

test('three slashes collapse to one', () => {
	assert.equal(collapsedSlashRedirect('https://wp.example///cart/'), 'https://wp.example/cart/');
});

// #1005: a 301 on POST (and any method that may have written) is followed as
// GET. The order or webhook body is lost. GET, HEAD and OPTIONS stay a redirect.
test('GET, HEAD and OPTIONS still redirect a doubled slash (#1005)', () => {
	for (const method of ['GET', 'HEAD', 'OPTIONS']) {
		assert.equal(mayHaveWritten(method), false);
		assert.equal(collapsedSlashRedirect(ORDERS, method), COLLAPSED);
		assert.equal(
			collapsedSlashRedirect('https://wp.example//checkout-link?products=abc', method),
			'https://wp.example/checkout-link?products=abc'
		);
	}
});

test('POST //wp-json/wc/v3/orders is not a redirect, so the body is not dropped (#1005)', () => {
	assert.equal(mayHaveWritten('POST'), true);
	assert.equal(collapsedSlashRedirect(ORDERS, 'POST'), null);
});

test('PUT, PATCH and DELETE on a doubled slash are not redirects (#1005)', () => {
	for (const method of ['PUT', 'PATCH', 'DELETE']) {
		assert.equal(mayHaveWritten(method), true);
		assert.equal(collapsedSlashRedirect(ORDERS, method), null);
	}
});

test('the gateway passes the method, so a POST is not answered 301 (#1005)', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const at = src.indexOf('const merged = collapsedSlashRedirect(');
	assert.ok(at !== -1, 'gateway calls collapsedSlashRedirect');
	const call = src.slice(at, src.indexOf('\n', at));
	assert.match(
		call,
		/collapsedSlashRedirect\(req\.url,\s*req\.method\)/,
		'the gateway must pass req.method or a POST is answered 301'
	);
	assert.match(src, /Response\.redirect\(merged, 301\)/);
});
