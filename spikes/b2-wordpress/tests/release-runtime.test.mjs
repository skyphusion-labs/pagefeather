// node --test spikes/b2-wordpress/tests/release-runtime.test.mjs (#394 (b))
// index.js cannot be imported under node (it loads php-wasm), so this reads its source, as
// site-lock.test.mjs does: a recycled runtime must be RELEASED (lastBootedPhp cleared, exit() called),
// and only after the response for its last request is built.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('releaseRuntime clears lastBootedPhp and exits the runtime, never throwing', () => {
	const start = src.indexOf('function releaseRuntime(php) {');
	assert.ok(start >= 0, 'releaseRuntime not found');
	const body = src.slice(start, src.indexOf('\n}\n', start));
	assert.match(body, /if \(lastBootedPhp === php\) lastBootedPhp = null;/);
	assert.match(body, /try \{\s*php\.exit\(0\);\s*\} catch/);
});

test('the memory recycle marks the runtime, and it is released after the response is built', () => {
	const rec = src.indexOf("if (crashed || (wasmBytes > RECYCLE_WASM_BYTES && env.PHP_RECYCLE !== 'off')) {");
	assert.ok(rec >= 0, 'recycle block not found');
	const block = src.slice(rec, src.indexOf('\n\t\t\t}', rec));
	assert.match(block, /bootPromise = null;/);
	assert.match(block, /recycled = php;/);
	const built = src.indexOf('const response = new Response(r.bytes, { status: r.httpStatusCode, headers: out });', rec);
	const released = src.indexOf('if (recycled) releaseRuntime(recycled);', rec);
	const returned = src.indexOf('return response;', rec);
	assert.ok(built > rec && released > built && returned > released, 'order must be: build the response, release, return');
});
