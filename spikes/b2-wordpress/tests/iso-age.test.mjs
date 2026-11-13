// node --test spikes/b2-wordpress/tests/iso-age.test.mjs (#474)
// x-perf isoAgeS must be the isolate's age, not epoch seconds: Date.now() reads 0 at module scope in
// Workers, so isolateStart is set on the first request, never at module scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('isolateStart is not Date.now() at module scope', () => {
	assert.ok(!/^const isolateStart = Date\.now\(\);/m.test(src), 'module-scope Date.now() reads 0 in Workers');
	assert.match(src, /^let isolateStart = 0;/m);
});

test('it is set on the first request, before the perf block reads it', () => {
	const set = src.indexOf('if (!isolateStart) isolateStart = Date.now();');
	const read = src.indexOf('isoAgeS: Math.round((now - isolateStart) / 1000),');
	assert.ok(set > 0 && read > set, 'set before read');
	// inside the request handler: after the boot decision is reached from a request, not module scope
	const fnStart = src.lastIndexOf('\n\t\ttry {\n', set);
	assert.ok(fnStart > 0 && set - fnStart < 40, 'the first statement of the request try block');
});
