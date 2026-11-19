// node --test spikes/b2-wordpress/tests/object-cache-cap.test.mjs (#963)
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { OBJECT_CACHE_MAX_BYTES, PRODUCT_ADMIN_OC_BYTES, nextObjectCacheCap } from '../object-cache-cap.mjs';

test('the product admin cap is 1 MiB and the ceiling stays 8 MiB', () => {
	assert.equal(PRODUCT_ADMIN_OC_BYTES, 1048576);
	assert.equal(OBJECT_CACHE_MAX_BYTES, 8 * 1048576);
	assert.equal(nextObjectCacheCap({ op: 'cap', n: PRODUCT_ADMIN_OC_BYTES }), PRODUCT_ADMIN_OC_BYTES);
});

test('a cap op clamps to the floor and the ceiling', () => {
	assert.equal(nextObjectCacheCap({ op: 'cap', n: 1000 }), 256 * 1024);
	assert.equal(nextObjectCacheCap({ op: 'cap', n: 99 * 1048576 }), OBJECT_CACHE_MAX_BYTES);
	assert.equal(nextObjectCacheCap({ op: 'cap', n: 256 * 1024 }), 256 * 1024);
});

test('any other op keeps the current cap', () => {
	assert.equal(nextObjectCacheCap({ op: 'flush' }, 1048576), 1048576);
	assert.equal(nextObjectCacheCap({ op: 'cap', n: '1048576' }, 222), 222);
	assert.equal(nextObjectCacheCap(null, 222), 222);
});

test('index.js applies the cap and restores 8 MiB at the next request', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{ OBJECT_CACHE_MAX_BYTES, nextObjectCacheCap \} from '\.\/object-cache-cap\.mjs'/);
	assert.match(src, /let objectCacheCap = OBJECT_CACHE_BYTES/);
	assert.match(src, /objectCacheCap = nextObjectCacheCap\(op, objectCacheCap\)/);
	assert.match(src, /if \(objectCacheBytes <= objectCacheCap\) break/);
	assert.match(src, /function ocReqBegin\(\) \{ ocReq = \{ writes: new Set\(\), poisoned: false \}; objectCacheCap = OBJECT_CACHE_BYTES; \}/);
	assert.match(src, /n > objectCacheCap \/ 4/);
});
