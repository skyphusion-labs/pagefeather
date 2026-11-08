import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_HTTP_ALLOW_HOSTS, resolveHttpAllowHosts, httpHostAllowed, configuredHttpAllowHosts } from '../http-allow.mjs';

test('unset uses the WordPress, WooCommerce and Gravatar hosts', () => {
	assert.equal(resolveHttpAllowHosts(undefined), DEFAULT_HTTP_ALLOW_HOSTS);
	assert.equal(httpHostAllowed('api.wordpress.org', DEFAULT_HTTP_ALLOW_HOSTS), true);
	assert.equal(httpHostAllowed('wordpress.org', DEFAULT_HTTP_ALLOW_HOSTS), true);
	assert.equal(httpHostAllowed('secure.gravatar.com', DEFAULT_HTTP_ALLOW_HOSTS), true);
	assert.equal(httpHostAllowed('api.woocommerce.com', DEFAULT_HTTP_ALLOW_HOSTS), true);
});

test('an empty list denies, and a star allows', () => {
	assert.equal(resolveHttpAllowHosts(''), '');
	assert.equal(httpHostAllowed('api.wordpress.org', ''), false);
	assert.equal(httpHostAllowed('example.com', '*'), true);
});

test('a suffix does not match a different host that merely ends the same way', () => {
	assert.equal(httpHostAllowed('notwordpress.org', '.wordpress.org'), false);
	assert.equal(httpHostAllowed('wordpress.org.evil.com', '.wordpress.org'), false);
	assert.equal(httpHostAllowed('paypal.com', '.wordpress.org'), false);
});

test('a generated config keeps an explicit list and fills the default when unset', () => {
	assert.equal(configuredHttpAllowHosts({}), DEFAULT_HTTP_ALLOW_HOSTS);
	assert.equal(configuredHttpAllowHosts({ HTTP_ALLOW_HOSTS: '' }), '');
	assert.equal(configuredHttpAllowHosts({ HTTP_ALLOW_HOSTS: '.wordpress.org,paypal.com' }), '.wordpress.org,paypal.com');
	assert.throws(() => configuredHttpAllowHosts({ HTTP_ALLOW_HOSTS: 'a"b' }));
});
