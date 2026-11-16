// #756: /_install keeps the runtime it ran on, so the first page reuses it. Dropping it made the first page
// boot a second runtime beside the dropped one's uncollected WebAssembly memory, and the isolate died of
// exceededMemory (6 of 6 install-then-page deploys, wl-754b2 and wl-714probe).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const h = src.indexOf("if (url.pathname === '/_install') {");
const end = src.indexOf('return Response.json({ bootMs', h);
const block = src.slice(h, end);

test('#756 /_install runs INSTALL and does not drop its runtime afterwards', () => {
	assert.ok(h >= 0 && end > h, 'the /_install block is found');
	assert.match(block, /php\.run\(\{ code: INSTALL \}\)/, 'it runs the install script');
	assert.doesNotMatch(block, /dropRuntime(Idle)?\(\)/, 'no drop after the install: the first page reuses this runtime');
});

test('#756 /_install still clears the object cache (the database changed outside WordPress)', () => {
	assert.match(block, /objectCacheClear\(\);/);
});
