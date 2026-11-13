// Tests of origin-store.mjs (issue #391): a GET that changes nothing writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ORIGIN_KEY, storeOriginIfChanged } from '../origin-store.mjs';

function fakeStorage(init) {
	const m = new Map(Object.entries(init || {}));
	const log = [];
	return {
		log,
		async get(k) { log.push(['get', k]); return m.get(k); },
		async put(k, v, opts) { log.push(['put', k, v, opts]); m.set(k, v); },
	};
}

test('the same origin as cached: no read, no write', async () => {
	const s = fakeStorage({ [ORIGIN_KEY]: 'https://shop.example' });
	assert.equal(await storeOriginIfChanged(s, 'https://shop.example', 'https://shop.example'), false);
	assert.deepEqual(s.log, []);
});

test('a fresh isolate (nothing cached) with the origin stored: one read, no write', async () => {
	const s = fakeStorage({ [ORIGIN_KEY]: 'https://shop.example' });
	assert.equal(await storeOriginIfChanged(s, 'https://shop.example', null), false);
	assert.deepEqual(s.log.map((e) => e[0]), ['get']);
});

test('a new or changed origin is written, as a normal durable put (no options)', async () => {
	const s = fakeStorage({});
	assert.equal(await storeOriginIfChanged(s, 'https://shop.example', null), true);
	const c = fakeStorage({ [ORIGIN_KEY]: 'https://old.example' });
	assert.equal(await storeOriginIfChanged(c, 'https://shop.example', 'https://old.example'), true);
	for (const st of [s, c]) {
		const put = st.log.find((e) => e[0] === 'put');
		assert.deepEqual(put.slice(0, 3), ['put', ORIGIN_KEY, 'https://shop.example']);
		assert.equal(put[3], undefined, 'never allowUnconfirmed or noCache');
	}
});

test('index.js: fetch stores the origin only through storeOriginIfChanged, and never with allowUnconfirmed', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.ok(!/storage\.put\(ORIGIN_KEY/.test(src), 'no unconditional ORIGIN_KEY put');
	assert.match(src, /await storeOriginIfChanged\(this\.ctx\.storage, origin, lastOrigin\)/);
	assert.ok(!/allowUnconfirmed/.test(src), 'no write gives up its confirmation');
});
