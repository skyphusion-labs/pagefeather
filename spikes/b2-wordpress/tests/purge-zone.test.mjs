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
	ownPurgeHost,
} from '../purge-zone.mjs';

const HOST = 'x.test';

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

test('the own host is the lower-case hostname of the site origin', () => {
	assert.equal(ownPurgeHost('https://Shop.Example.co/'), 'shop.example.co');
	assert.equal(ownPurgeHost('https://x.test'), 'x.test');
	assert.equal(ownPurgeHost(''), '');
	assert.equal(ownPurgeHost(undefined), '');
	assert.equal(ownPurgeHost('not a url'), '');
});

test('a theme-wide change purges the site own host, never the whole zone', () => {
	assert.deepEqual(purgeZoneBody({ everything: true }, HOST), { hosts: [HOST] });
	// An empty op names nothing that changed, so it purges nothing (as before).
	assert.equal(purgeZoneBody({}, HOST), null);
	assert.deepEqual(purgeZoneBody(null, HOST), { hosts: [HOST] });
	assert.deepEqual(purgeZoneBody(undefined, HOST), { hosts: [HOST] });
	for (const op of [{ everything: true }, {}, null, undefined]) {
		assert.equal('purge_everything' in (purgeZoneBody(op, HOST) || {}), false);
	}
});

test('with no own host, nothing is purged (never the whole zone)', () => {
	assert.equal(purgeZoneBody({ everything: true }, ''), null);
	assert.equal(purgeZoneBody({ files: ['https://x.test/p/'] }, ''), null);
	assert.equal(purgeZoneBody({ everything: true }), null);
});

test('a URL on another host is dropped', () => {
	assert.deepEqual(
		purgeZoneBody({ files: ['https://x.test/p/', 'https://other.test/p/', 'https://X.TEST/q/', 'https://sub.x.test/r/'] }, HOST),
		{ files: ['https://x.test/p/', 'https://X.TEST/q/'] }
	);
	assert.equal(purgeZoneBody({ files: ['https://other.test/p/'] }, HOST), null);
	assert.deepEqual(dedupeFiles(['https://other.test/a', 'https://x.test/b'], HOST), ['https://x.test/b']);
});

test('a URL change purges the deduped file list', () => {
	assert.deepEqual(
		purgeZoneBody({ files: ['https://x.test/p/', 'https://x.test/', 'https://x.test/p/'] }, HOST),
		{ files: ['https://x.test/p/', 'https://x.test/'] }
	);
});

test('no usable URL means no call', () => {
	assert.equal(purgeZoneBody({ files: [] }, HOST), null);
	assert.equal(purgeZoneBody({ files: ['notaurl', ''] }, HOST), null);
});

test('more URLs than the cap fall back to a purge of the own host', () => {
	const many = Array.from({ length: PURGE_URL_CAP + 1 }, (_, i) => `https://x.test/p/${i}`);
	assert.deepEqual(purgeZoneBody({ files: many }, HOST), { hosts: [HOST] });
	// Exactly the cap is still a file list.
	const atCap = Array.from({ length: PURGE_URL_CAP }, (_, i) => `https://x.test/p/${i}`);
	assert.equal(purgeZoneBody({ files: atCap }, HOST).files.length, PURGE_URL_CAP);
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
