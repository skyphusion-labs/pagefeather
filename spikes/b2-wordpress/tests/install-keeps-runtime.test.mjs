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

// #756 review (the spec's fail branch): an install runtime ABOVE the recycle line. /_install answers before the
// recycle decision, so that runtime is kept for the first page, which runs on it with no second boot; the decision
// after that page's run recycles it ('memory'). The boot beside a dropped heap then moves to the SECOND request,
// exactly as every memory recycle does today (recycle-line.mjs). It is never earlier than on main, where the first
// page always booted beside the install's dropped runtime. Applying the decision inside /_install would bring the
// first-page death back, so it must stay out.
test('#756 /_install answers before the recycle decision: an over-line runtime is recycled after the FIRST page, not before it', async () => {
	const decide = src.indexOf('const recycleWhy = recycleDecision(');
	assert.ok(decide > 0, 'the per-request recycle decision is found');
	assert.ok(end < decide, '/_install returns before the recycle decision');
	assert.doesNotMatch(block, /recycleDecision\(/, 'the install block makes no recycle decision of its own');
	const { recycleDecision } = await import('../recycle-line.mjs');
	const MiB = 1048576;
	assert.equal(recycleDecision({ wasmBytes: 150 * MiB, lineBytes: 140 * MiB }), 'memory', 'the first page run on an over-line kept runtime recycles it');
	assert.equal(recycleDecision({ wasmBytes: 75.1 * MiB, lineBytes: 140 * MiB }), null, 'the measured install runtime (75.1 MiB, pf756k1/k2/k4) is kept');
});
