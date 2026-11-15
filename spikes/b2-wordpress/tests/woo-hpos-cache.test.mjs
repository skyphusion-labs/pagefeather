// #697: the Worker defines SKYPHUSION_WOO_HPOS_CACHE for approach A only (a site with the Hyperdrive dbHandler), and
// only when WOO_HPOS_CACHE is exactly "on". b-dosql (no dbHandler) never gets it, whatever its vars say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hposCacheDefine } from '../woo-hpos-cache.mjs';

test('approach A with WOO_HPOS_CACHE=on defines the constant', () => {
	assert.equal(hposCacheDefine({ WOO_HPOS_CACHE: 'on' }, true), "define('SKYPHUSION_WOO_HPOS_CACHE', 'on');");
});
test('unset, or any other value, defines nothing (WooCommerce keeps its own setting)', () => {
	for (const v of [undefined, '', 'off', 'yes', '1', 'ON', ' on']) assert.equal(hposCacheDefine({ WOO_HPOS_CACHE: v }, true), null, String(v));
	assert.equal(hposCacheDefine({}, true), null);
	assert.equal(hposCacheDefine(undefined, true), null);
});
test('b-dosql (no Hyperdrive dbHandler) never gets it, even with the var set', () => {
	assert.equal(hposCacheDefine({ WOO_HPOS_CACHE: 'on' }, false), null);
});
