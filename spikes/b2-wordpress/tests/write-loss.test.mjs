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
	// The construction of PHP's own answer (#394 (b) builds it before releasing a recycled runtime, then returns it).
	const answer = src.indexOf('new Response(r.bytes, { status: r.httpStatusCode, headers: out })');
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
	const branch = src.indexOf("if (objectErrorOutcome(kind, req.method) === 'write-loss') {");
	const wl = src.indexOf("writeLossResponse('unknown'", branch);
	const h503 = src.indexOf('const headers = objectErrorHeaders(kind, name, OVERLOAD_RETRY_AFTER_S);', branch);
	assert.ok(branch > 0 && wl > branch && h503 > wl, 'the write-loss answer comes before the 503 headers');
	assert.match(src.slice(branch, h503), /'@event': 'write-loss'.*phase: 'request-killed'/s);
});

// The write-loss event logs the statement's verb and table only, never its values (a store's SQL can
// hold an email or an address; Workers Logs is not a data store).
import { sqlShape } from '../write-loss.mjs';
test('sqlShape keeps the verb and the table only', () => {
	assert.equal(sqlShape("UPDATE `wp_options` SET `option_value` = COALESCE(CAST('6af65f8cad5a47.45896392|1794"), 'UPDATE wp_options');
	assert.equal(sqlShape("INSERT INTO `wp_wc_orders` (`billing_email`) VALUES ('buyer@example.com')"), 'INSERT wp_wc_orders');
	assert.equal(sqlShape('DELETE FROM wp_usermeta WHERE user_id = 7'), 'DELETE wp_usermeta');
	assert.equal(sqlShape("REPLACE INTO wp_options VALUES ('x')"), 'REPLACE wp_options');
	assert.equal(sqlShape("SELECT * FROM `wp_users` WHERE user_email = 'a@b.c'"), 'SELECT wp_users');
	assert.equal(sqlShape('(binary SQL)'), 'OTHER');
	assert.equal(sqlShape(''), 'OTHER');
	assert.ok(!sqlShape("INSERT INTO t VALUES ('buyer@example.com')").includes('@'));
});
test('index.js: the write-loss event logs sqlShape, never the statement text', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.ok(src.includes('firstSql: sqlShape(d.failures[0].sql)'));
	assert.ok(!src.includes("firstSql: String(d.failures[0].sql || '').slice(0, 80)"));
});
test('index.js: the dead-letter event logs a recipient count, never an address', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const at = src.indexOf("m: 'email-dead-letter'");
	assert.ok(at > 0);
	const line = src.slice(src.lastIndexOf('\n', at), src.indexOf('\n', at));
	assert.ok(line.includes('recipients:') && !/\bto: Array\.isArray\(to\)/.test(line), line);
});
test('index.js: no log line carries a URL query string (order keys and logins live there)', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const logs = src.split('\n').filter((l) => /console\.(log|error|warn)\(/.test(l));
	assert.ok(logs.length > 20, 'the scan read the log lines');
	assert.deepEqual(logs.filter((l) => /url\.search|url\.href|req\.url/.test(l)), []);
});

// #398: the write-loss answer names the reset that killed the request.
test('writeLossResponse: x-isolate-reset names the kind, memory by default', () => {
	assert.equal(writeLossResponse('unknown').headers['x-isolate-reset'], 'memory');
	assert.equal(writeLossResponse('unknown', false, 'memory').headers['x-isolate-reset'], 'memory');
	const s = writeLossResponse('unknown', true, 'storage');
	assert.equal(s.status, 500);
	assert.equal(s.headers['x-isolate-reset'], 'storage');
	assert.equal(s.headers['x-write-loss'], 'unknown');
	assert.equal(s.headers['retry-after'], undefined);
	assert.equal(JSON.parse(s.body).message, WRITE_LOSS_MESSAGE);
});
