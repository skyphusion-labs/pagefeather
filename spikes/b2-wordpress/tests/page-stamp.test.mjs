// The render stamp of the cached Pages entrypoint (#628). A cached copy keeps the stamp of the run
// that rendered it, so two reads with the same stamp were served from a cache, whatever the outer
// cf-cache-status says. Measured 2026-11-15 on pfa-sb1114l (a flat config with a top-level [cache]):
// 934 front runs and 21 Pages runs answered with EXPIRED outside, so the outer status hid the inner hit.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { RENDERED_HEADER, stampRendered } from '../page-stamp.mjs';

test('the stamp is the render time in milliseconds, under one header name', () => {
	const h = new Headers();
	stampRendered(h, 1763200000123);
	assert.equal(RENDERED_HEADER, 'x-pf-rendered');
	assert.equal(h.get('x-pf-rendered'), '1763200000123');
});

test('a new render replaces an old stamp, never adds a second one', () => {
	const h = new Headers({ 'x-pf-rendered': '1' });
	stampRendered(h, 2);
	assert.equal(h.get('x-pf-rendered'), '2');
});

test('the default clock is Date.now', () => {
	const h = new Headers();
	const t0 = Date.now();
	stampRendered(h);
	const v = Number(h.get('x-pf-rendered'));
	assert.ok(v >= t0 && v <= Date.now() + 1, String(v));
});

test('index.js stamps in Pages.fetch, on the response the cache stores, and nowhere else', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const pages = src.slice(src.indexOf('export class Pages extends WorkerEntrypoint'));
	const fetchBody = pages.slice(0, pages.indexOf('async purge('));
	assert.match(fetchBody, /stampRendered\(out\.headers\)/, 'Pages.fetch stamps its answer');
	assert.equal((src.match(/stampRendered\(/g) || []).length, 1, 'one stamp site only (the gateway never stamps)');
	assert.match(src, /import \{ stampRendered \} from '\.\/page-stamp\.mjs';/);
});
