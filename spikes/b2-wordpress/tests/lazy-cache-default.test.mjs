// node --test spikes/b2-wordpress/tests/lazy-cache-default.test.mjs (#394)
// The lazy inflate cache defaults to 2 MiB: at 8 MiB it was full at every failing post-new INSERT, and
// at 2 MiB post-new died 60 of 100 rounds against 82 of 100, at no measured boot cost (#394).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('LAZY_CACHE_BYTES defaults to 2 MiB', () => {
	assert.match(src, /^let LAZY_CACHE_BYTES = 2 \* 1024 \* 1024;$/m);
	assert.ok(!/^let LAZY_CACHE_BYTES = 8 \* 1024 \* 1024;/m.test(src), 'the old 8 MiB default is gone');
});

test('LAZY_CACHE_MB still overrides it, and a bad value keeps the default', () => {
	assert.match(src, /if \(ENV\.LAZY_CACHE_MB\) \{\s*const mb = Number\(ENV\.LAZY_CACHE_MB\);\s*if \(Number\.isFinite\(mb\)\) LAZY_CACHE_BYTES = Math\.max\(1, mb\) \* 1024 \* 1024;/);
});
