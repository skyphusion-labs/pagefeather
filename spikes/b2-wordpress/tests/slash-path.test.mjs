import assert from 'node:assert/strict';
import test from 'node:test';
import { collapsedSlashRedirect } from '../slash-path.mjs';

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
