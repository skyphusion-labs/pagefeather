// node --test tests/purge-zone.test.mjs
// Unit tests for the zone cache purge helpers (issue #205). These are the pure
// parts index.js builds the purgeZone op and the config gate from.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	PURGE_URL_CAP,
	cfPurgeEndpoint,
	dedupeFiles,
	purgeZoneBody,
	cachePurgeEnabled,
} from '../purge-zone.mjs';

test('the endpoint names the zone and path-encodes it', () => {
	assert.equal(
		cfPurgeEndpoint('abc123'),
		'https://api.cloudflare.com/client/v4/zones/abc123/purge_cache'
	);
	assert.equal(
		cfPurgeEndpoint('a/b'),
		'https://api.cloudflare.com/client/v4/zones/a%2Fb/purge_cache'
	);
});

test('dedupeFiles keeps order, drops duplicates and non-http values', () => {
	assert.deepEqual(
		dedupeFiles([
			'https://x.test/post/',
			'https://x.test/',
			'https://x.test/post/',
			'ftp://x.test/no',
			'',
			42,
			'  https://x.test/feed/  ',
		]),
		['https://x.test/post/', 'https://x.test/', 'https://x.test/feed/']
	);
	assert.deepEqual(dedupeFiles(undefined), []);
	assert.deepEqual(dedupeFiles('not-an-array'), []);
});

test('a theme-wide change purges everything', () => {
	assert.deepEqual(purgeZoneBody({ everything: true }), { purge_everything: true });
	assert.deepEqual(purgeZoneBody(null), { purge_everything: true });
	assert.deepEqual(purgeZoneBody(undefined), { purge_everything: true });
});

test('a URL change purges the deduped file list', () => {
	assert.deepEqual(
		purgeZoneBody({ files: ['https://x.test/p/', 'https://x.test/', 'https://x.test/p/'] }),
		{ files: ['https://x.test/p/', 'https://x.test/'] }
	);
});

test('no usable URL means no call', () => {
	assert.equal(purgeZoneBody({ files: [] }), null);
	assert.equal(purgeZoneBody({ files: ['notaurl', ''] }), null);
});

test('more URLs than the cap fall back to purge_everything', () => {
	const many = Array.from({ length: PURGE_URL_CAP + 1 }, (_, i) => `https://x.test/p/${i}`);
	assert.deepEqual(purgeZoneBody({ files: many }), { purge_everything: true });
	// Exactly the cap is still a file list.
	const atCap = Array.from({ length: PURGE_URL_CAP }, (_, i) => `https://x.test/p/${i}`);
	assert.equal(purgeZoneBody({ files: atCap }).files.length, PURGE_URL_CAP);
});

test('the gate is on only with the DO profile and both bindings, off switch wins', () => {
	const on = { PHP_IN_DO: 'on', DB_IN_DO: 'on', PURGE_TOKEN: 't', PURGE_ZONE: 'z' };
	assert.equal(cachePurgeEnabled(on), true);
	assert.equal(cachePurgeEnabled({ ...on, CACHE_PURGE: 'off' }), false);
	assert.equal(cachePurgeEnabled({ ...on, PURGE_TOKEN: '' }), false);
	assert.equal(cachePurgeEnabled({ ...on, PURGE_ZONE: undefined }), false);
	assert.equal(cachePurgeEnabled({ ...on, PHP_IN_DO: 'off' }), false);
	assert.equal(cachePurgeEnabled({ ...on, DB_IN_DO: 'off' }), false);
	assert.equal(cachePurgeEnabled(undefined), false);
});
