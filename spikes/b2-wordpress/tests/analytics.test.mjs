// node --test tests/analytics.test.mjs
// Unit tests for the pageview analytics op helpers (#201 Phase 2). These are the
// pure parts index.js builds the analytics op and the config gate from, plus the
// writeDataPoint SHAPE exercised against a STUB dataset.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	buildDataPoint,
	sanitizePath,
	recordPageview,
	analyticsEnabled,
	HOST_MAX,
	PATH_MAX,
} from '../analytics.mjs';

test('buildDataPoint emits the exact blobs/doubles/indexes shape', () => {
	const dp = buildDataPoint({ host: 'blog.example.com', path: '/hello-world', status: '200', country: 'US' });
	assert.deepEqual(dp.blobs, ['blog.example.com', '/hello-world', '200', 'US']);
	assert.deepEqual(dp.doubles, [1]); // double1 = count
	assert.deepEqual(dp.indexes, ['blog.example.com']); // index1 = host, site level, never per-visitor
});

test('the query string and fragment are stripped from the path (privacy)', () => {
	assert.equal(buildDataPoint({ path: '/search?q=secret' }).blobs[1], '/search');
	assert.equal(sanitizePath('/page#section'), '/page');
	assert.equal(sanitizePath(''), '/');
	assert.equal(sanitizePath('foo'), '/foo'); // a path with no leading slash gains one
});

test('missing or odd fields never produce a non-string or oversized field', () => {
	const dp = buildDataPoint({});
	assert.deepEqual(dp.blobs, ['', '/', '', '']);
	assert.deepEqual(dp.indexes, ['']);
	assert.equal(buildDataPoint({ status: 404 }).blobs[2], '404'); // numeric coerced to string
	const longHost = 'h'.repeat(HOST_MAX + 50);
	assert.equal(buildDataPoint({ host: longHost }).blobs[0].length, HOST_MAX);
	assert.equal(buildDataPoint({ host: longHost }).indexes[0].length, HOST_MAX);
	assert.equal(buildDataPoint({ path: '/' + 'a'.repeat(PATH_MAX + 50) }).blobs[1].length, PATH_MAX);
});

test('recordPageview writes the built point once to the dataset, fire-and-forget', () => {
	let captured = null;
	let calls = 0;
	const stub = { writeDataPoint(pt) { calls++; captured = pt; } };
	const ret = recordPageview(stub, { host: 'a.test', path: '/p', status: '200', country: 'DE' });
	assert.equal(ret, undefined); // returns void (writeDataPoint is void)
	assert.equal(calls, 1);
	assert.deepEqual(captured, { blobs: ['a.test', '/p', '200', 'DE'], doubles: [1], indexes: ['a.test'] });
});

test('analyticsEnabled is OPT-IN: DO profile + ANALYTICS binding + WP_ANALYTICS on', () => {
	const base = { PHP_IN_DO: 'on', DB_IN_DO: 'on', ANALYTICS: {}, WP_ANALYTICS: 'on' };
	assert.equal(analyticsEnabled(base), true);
	assert.equal(analyticsEnabled({ ...base, ANALYTICS: undefined }), false);
	// a privacy feature, so it requires 'on' explicitly, not merely != 'off'
	assert.equal(analyticsEnabled({ ...base, WP_ANALYTICS: undefined }), false);
	assert.equal(analyticsEnabled({ ...base, WP_ANALYTICS: 'off' }), false);
	assert.equal(analyticsEnabled({ ...base, DB_IN_DO: undefined }), false);
	assert.equal(analyticsEnabled({ ...base, PHP_IN_DO: undefined }), false);
	assert.equal(analyticsEnabled({}), false);
	assert.equal(analyticsEnabled(null), false);
});
