// #724 review, finding 3: with PHP_MEMORY_REUSE and BOOT_GATE off, index.js does what main does, except the changes the
// PR lists as unflagged on purpose. node --test tests/reuse-flag-off.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recycleDecision } from '../recycle-line.mjs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const fn = (name) => { const a = src.indexOf(name); return a < 0 ? '' : src.slice(a, src.indexOf('\n}\n', a)); };

test('a drop at the start of a request releases at once ONLY with reuse on (flag off: queued, as main)', () => {
	const f = fn('function dropRuntimeIdle() {');
	assert.ok(f, 'no dropRuntimeIdle');
	assert.match(f, /if \(held && reuseActive\(\)\) retirer\.releaseNow\(held\);/, 'releaseNow (php.exit mid-request) is not behind the flag');
});

test('boot() waits only with reuse or the gate on (flag off: no added await, as main)', () => {
	const f = fn('async function boot(origin) {');
	assert.match(f, /if \(reuseActive\(\) \|\| gateSettings\(ENV\)\.on\) \{\n(\t\t\/\/[^\n]*\n)*\t\tawait null;/, 'boot() awaits with both flags off');
	// and nothing before that guard awaits
	assert.ok(!/await /.test(f.slice(0, f.indexOf('if (reuseActive() || gateSettings(ENV).on) {'))), 'an await before the guard');
});

test('the recycle line reads bootBytes only with reuse on (flag off: today\'s rule)', () => {
	assert.match(src, /bootBytes: reuseActive\(\) \? runtimeBootBytes : 0/, 'bootBytes reaches the recycle decision with reuse off');
	// and bootBytes 0 is today's rule exactly
	const MiB = 1048576;
	for (const w of [99, 101, 140]) assert.equal(recycleDecision({ wasmBytes: w * MiB, lineBytes: 100 * MiB, bootBytes: 0 }), recycleDecision({ wasmBytes: w * MiB, lineBytes: 100 * MiB }));
});
