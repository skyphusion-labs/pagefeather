// node --test spikes/b2-wordpress/tests/oc-l1.test.mjs (#1078)
// The isolate L1 life of a VERSIONED object-cache key. On approach A, options persist across requests under their exact
// version (#296 (2)): the drop-in's key carries the version as salt, and any options write renames every options key.
// So a versioned key cannot go stale, and its L1 entry needs no time bound: memory (the L1 cap) evicts it. Any other key
// keeps the short OBJECT_CACHE_TTL. Measured on cf759hl (#1078, the KV L2 off): run 6 (no versioned L1) made list posts
// 133 queries and trash post 118; run 5 (with it) made 74 and 73, because a request more than 10 s after the last one
// re-read every options key from MySQL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isVersionedKey, l1ExpFor } from '../oc-l1.mjs';

const SHORT = 10_000;
const vkey = (v, k) => 'options\0v' + v + '\0' + k; // the drop-in pkey: group NUL salt NUL key
const ukey = (k) => 'theme_json\0' + k;

test('isVersionedKey: only a version-salted key', () => {
	assert.ok(isVersionedKey(vkey(7, 'alloptions')));
	assert.ok(!isVersionedKey(ukey('x')));
	assert.ok(!isVersionedKey('options\0x'), 'options with no version read stays unversioned');
	assert.ok(!isVersionedKey('options\0vx\0k'), 'v must be followed by digits');
});
test('l1ExpFor: a versioned key has no time bound (0); any other key the short TTL', () => {
	assert.equal(l1ExpFor(vkey(7, 'alloptions'), 1000, SHORT), 0);
	assert.equal(l1ExpFor(ukey('x'), 1000, SHORT), 1000 + SHORT);
});
test('CROSS-ISOLATE: a long-lived v7 value is never served once the version is v8', () => {
	// Isolate 1 holds alloptions under v7 with no time bound. Isolate 2 writes an option: the trigger bumps 7 to 8 in the
	// same statement. Isolate 1's next request reads version 8 at its start and asks for the v8 key, which its L1 never
	// held: the v7 value is unreachable, and memory evicts it.
	const l1 = new Map([[vkey(7, 'alloptions'), { v: 'OLD', exp: l1ExpFor(vkey(7, 'alloptions'), 0, SHORT) }]]);
	assert.equal(l1.get(vkey(8, 'alloptions')), undefined);
});
test('index.js: a set and an L2 hit store a versioned key with no time bound; others keep their TTL', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{ isVersionedKey, l1ExpFor \} from '\.\/oc-l1\.mjs';/);
	assert.match(src, /ocStore\(k, kv, l1ExpFor\(k, now, ocTtlMs\(\)\)\)/);
	assert.match(src, /ocStore\(op\.k, op\.v, isVersionedKey\(op\.k\) \? 0 : op\.ttl > 0 \? now \+ op\.ttl \* 1000 : 0\)/);
});
