// node --test spikes/b2-wordpress/tests/activate-report.test.mjs (#744): /_activate names the database failures of its
// own run. Before, it returned the first 2,000 characters of PHP's error output, which cut WordPress's database error
// mid-query: WooCommerce's cart-page probe failed ("LIKE or GLOB pattern too complex") and the answer showed only the
// query head (and db_error was null, because a later statement succeeded). Every failed statement already passes
// noteFailure with its SQL and error; now each gets a sequence number, and /_activate returns the ones after its start,
// bounded (count, at most 20 entries, error and SQL cut), never cut mid-message for the first 400 characters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { failuresSince, MAX_FAILURES, ERROR_CHARS, SQL_CHARS } from '../activate-report.mjs';

test('only the failures after the run started, in order, with the total count', () => {
	const f = [1, 2, 3, 4].map((seq) => ({ seq, sql: 'SELECT ' + seq, error: 'E' + seq }));
	const r = failuresSince(f, 2);
	assert.equal(r.count, 2);
	assert.deepEqual(r.failures, [{ error: 'E3', sql: 'SELECT 3' }, { error: 'E4', sql: 'SELECT 4' }]);
});
test('none since the start: count 0, an empty list', () => {
	assert.deepEqual(failuresSince([{ seq: 1, sql: 'x', error: 'y' }], 1), { count: 0, failures: [] });
	assert.deepEqual(failuresSince(undefined, 0), { count: 0, failures: [] });
});
test('bounded: at most MAX_FAILURES entries, each error and SQL cut, the count still the total', () => {
	const f = Array.from({ length: 50 }, (_, i) => ({ seq: i + 1, sql: 'S'.repeat(5000), error: 'LIKE or GLOB pattern too complex: SQLITE_ERROR' + ' x'.repeat(2000) }));
	const r = failuresSince(f, 0);
	assert.equal(r.count, 50);
	assert.equal(r.failures.length, MAX_FAILURES);
	assert.ok(r.failures.every((x) => x.error.length <= ERROR_CHARS && x.sql.length <= SQL_CHARS));
	assert.ok(r.failures[0].error.startsWith('LIKE or GLOB pattern too complex: SQLITE_ERROR'), 'the message itself is kept, from its start');
	assert.ok(ERROR_CHARS >= 400 && SQL_CHARS >= 200);
});
test('a failure without a sequence number (none should exist) is never counted as new', () => {
	assert.equal(failuresSince([{ sql: 'x', error: 'y' }], 0).count, 0);
});
test('index.js wiring: noteFailure numbers each failure; /_activate returns its own failures', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{ failuresSince \} from '\.\/activate-report\.mjs';/);
	const nf = src.slice(src.indexOf('function noteFailure('), src.indexOf('function noteFailure(') + 300);
	assert.match(nf, /f\.seq = \+\+failureSeq;/, 'each failure gets the next sequence number');
	const act = src.slice(src.indexOf("if (url.pathname === '/_activate') {"), src.indexOf("if (url.pathname === '/_opcache-dump')"));
	assert.match(act, /const failSeq0 = failureSeq;/, 'the sequence at the start of the run');
	assert.match(act, /dbFailures: failuresSince\(stats\.failures, failSeq0\)/, 'the answer carries them');
});
