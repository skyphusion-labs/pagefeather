// #610: the OPcache shared memory of a runtime (opcache-size.mjs). The lead's ruling after the measurement on #610:
// a STORE (the build primes WooCommerce) gets 64 MB, every other site keeps 48, and an explicit PHP_INI still wins.
// The deploy paths render OPCACHE_MC = "64" for a store; the runtime takes exactly "64", and anything else is 48.
//   node --test spikes/b2-wordpress/tests/opcache-size.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { opcacheMemoryMib } from '../opcache-size.mjs';

test('a store (OPCACHE_MC = "64") gets 64', () => assert.equal(opcacheMemoryMib({ OPCACHE_MC: '64' }), '64'));
test('no var: 48 (a plain site, and every site before #610)', () => assert.equal(opcacheMemoryMib({}), '48'));
test('any other value: 48, never an unmeasured size', () => {
	for (const v of ['48', '65', '128', '64 ', ' 64', 'on', '', null, 64]) assert.equal(opcacheMemoryMib({ OPCACHE_MC: v }), '48', String(v));
});
test('no env: 48', () => assert.equal(opcacheMemoryMib(undefined), '48'));
test('index.js uses it for opcache.memory_consumption, and PHP_INI is spread after it (an explicit setting wins)', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /'opcache\.memory_consumption': opcacheMemoryMib\(ENV\)/);
	assert.match(src, /\.\.\.opcacheIni, \.\.\.deployIni, \.\.\.JSON\.parse\(ENV\.PHP_INI \|\| '\{\}'\)/);
});
