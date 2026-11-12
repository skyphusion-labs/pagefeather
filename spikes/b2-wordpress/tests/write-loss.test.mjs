// write-loss.mjs (#350): a request whose writes failed in an isolate memory reset never answers success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetFailures, writeLossResponse, WRITE_LOSS_BODY } from '../write-loss.mjs';

const RESET = "Durable Object's isolate exceeded its memory limit and was reset.";
test('THE FDPROBE1112H CASE: the session_tokens UPDATE failed in a reset, so the run has lost writes', () => {
	assert.equal(resetFailures([{ sql: 'UPDATE `wp_usermeta` SET `meta_value` = ...', error: RESET }, { sql: 'UPDATE ...', error: RESET }, { sql: 'UPDATE ...', error: RESET }]), 3);
});
test('other statement failures are not a reset (no replacement for an ordinary SQL error)', () => {
	assert.equal(resetFailures([{ sql: 'x', error: 'no such table: wp_foo' }, { sql: 'y', error: 'UNIQUE constraint failed' }]), 0);
	assert.equal(resetFailures([]), 0);
	assert.equal(resetFailures(undefined), 0);
});
test('a mix counts only the reset failures', () => {
	assert.equal(resetFailures([{ error: 'no such table' }, { error: RESET }]), 1);
});
test('the replacement: 500, no Retry-After, no Set-Cookie, never cached, says changes may be saved', () => {
	const r = writeLossResponse(3);
	assert.equal(r.status, 500, 'not 503: a blind retry can repeat what was saved before the reset');
	const h = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
	assert.equal(h['retry-after'], undefined);
	assert.equal(h['set-cookie'], undefined);
	assert.equal(h['cache-control'], 'no-store');
	assert.equal(h['x-isolate-reset'], 'memory');
	assert.equal(h['x-write-loss'], '3');
	assert.match(r.body, /may have been saved/);
	assert.equal(r.body, WRITE_LOSS_BODY);
});
test('index.js: the guard returns the replacement BEFORE PHP headers are copied and before PHP answer is built', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const guard = src.indexOf('const lost = resetFailures(d.failures);');
	const replace = src.indexOf('const wl = writeLossResponse(lost', guard);
	const copy = src.indexOf('for (const [k, v] of Object.entries(r.headers))', guard - 2000);
	const answer = src.indexOf('return new Response(r.bytes, { status: r.httpStatusCode, headers: out });');
	assert.ok(guard > 0 && replace > guard, 'the guard and its replacement are present');
	assert.ok(copy > replace, 'PHP headers (Set-Cookie) are copied only after the guard');
	assert.ok(answer > replace, 'PHP own answer is built only after the guard');
	assert.match(src.slice(guard, replace + 200), /'@event': 'write-loss'.*failed: lost/s, 'a structured log line with the failed count');
});

// The lead's ruling (2026-11-12): API calls get JSON; both reset paths; GET/HEAD keep #349's retry.
import { wantsJson, WRITE_LOSS_CODE, WRITE_LOSS_MESSAGE } from '../write-loss.mjs';
import { mayHaveWritten, shouldRetryObjectError } from '../object-error.mjs';
test('wantsJson: a REST route or a JSON client gets JSON, a page gets text', () => {
	assert.equal(wantsJson('/wp-json/wc/store/v1/checkout', '', ''), true);
	assert.equal(wantsJson('/', '?rest_route=/wc/store/v1/checkout', ''), true);
	assert.equal(wantsJson('/', '?p=1&rest_route=/x', ''), true);
	assert.equal(wantsJson('/wp-login.php', '', 'application/json, text/plain'), true);
	assert.equal(wantsJson('/wp-login.php', '', 'text/html'), false);
	assert.equal(wantsJson('/checkout/', '?a=b', undefined), false);
});
test('the JSON answer: code and message, parseable, same status and headers', () => {
	const r = writeLossResponse(2, true);
	assert.equal(r.status, 500);
	assert.match(r.headers['content-type'], /application\/json/);
	const d = JSON.parse(r.body);
	assert.equal(d.code, WRITE_LOSS_CODE); assert.equal(d.message, WRITE_LOSS_MESSAGE);
	assert.equal(r.headers['retry-after'], undefined);
});
test('the request-killed path reports the failed count as unknown', () => {
	assert.equal(writeLossResponse('unknown').headers['x-write-loss'], 'unknown');
});
test('mayHaveWritten: every method but GET and HEAD; those keep the #349 retry', () => {
	for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) assert.equal(mayHaveWritten(m), true, m);
	for (const m of ['GET', 'HEAD', 'get']) assert.equal(mayHaveWritten(m), false, m);
	assert.equal(shouldRetryObjectError('memory', 'GET', 0), true);
	assert.equal(shouldRetryObjectError('memory', 'POST', 0), false);
});
test('index.js toPhpObject: a writing method killed by a reset gets the 500 before the 503 is built', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const branch = src.indexOf("if (kind === 'memory' && mayHaveWritten(req.method)) {");
	const wl = src.indexOf("writeLossResponse('unknown'", branch);
	const h503 = src.indexOf('const headers = objectErrorHeaders(kind, name, OVERLOAD_RETRY_AFTER_S);', branch);
	assert.ok(branch > 0 && wl > branch && h503 > wl, 'the write-loss answer comes before the 503 headers');
	assert.match(src.slice(branch, h503), /'@event': 'write-loss'.*phase: 'request-killed'/s);
});
