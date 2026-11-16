// write-loss.mjs (#350): a request whose writes failed in an isolate memory reset never answers success.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resetFailures, writeLossResponse, WRITE_LOSS_BODY, statementFailureResponse } from '../write-loss.mjs';

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
	const lossLog = src.indexOf("'@event': 'write-loss'", replace);
	assert.ok(lossLog > replace, 'the log follows the client status');
	assert.match(src.slice(lossLog, src.indexOf('\n', lossLog)), /failed: lost/, 'a structured log line with the failed count');
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

// #596: phpStatus is PHP's own status, before the guard. A reader took phpStatus 200 for a success.
// The line must also carry the operator perf id (memIdOf) and answered, the status the client got.
import { perfHeadersAllowed } from '../perf-headers.mjs';
import { rolledBackResponse } from '../write-loss.mjs';

const indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const memAt = indexSrc.indexOf('function memIdOf(req, env) {');
const memBody = indexSrc.slice(memAt, indexSrc.indexOf('\n}', memAt) + 2);
const memRe = indexSrc.split('\n').find((l) => l.includes('const MEM_ID_RE = ')).match(/const MEM_ID_RE = (\/.*\/);/);
const MEM_ID_RE = new Function(`return ${memRe[1]};`)();
const memIdOf = new Function('perfHeadersAllowed', 'MEM_ID_RE', memBody + '\nreturn memIdOf;')(perfHeadersAllowed, MEM_ID_RE);

function objectLiteral(line) {
	const at = line.indexOf('JSON.stringify(');
	const start = line.indexOf('{', at);
	let depth = 0;
	for (let i = start; i < line.length; i++) {
		if (line[i] === '{') depth++;
		else if (line[i] === '}' && --depth === 0) return line.slice(start, i + 1);
	}
	throw new Error('no object literal: ' + line);
}
function logged(line, scope) {
	const names = Object.keys(scope);
	const value = new Function(...names, 'return ' + objectLiteral(line) + ';')(...names.map((k) => scope[k]));
	return JSON.parse(JSON.stringify(value));
}

const PERF_ID = 'm504-woo-97e9cd-8-edit-post';
const TOKEN = 'spike-token-value';
const post = (headers) => new Request('https://shop.example/wp-admin/post.php', { method: 'POST', headers });

test('#596: the write-loss lines carry id for a valid x-perf-id, no id without one, and answered equal to the status returned', () => {
	const lines = indexSrc.split('\n').filter((l) => l.includes("m: 'write-loss'"));
	assert.equal(lines.length, 2, 'the PHP-answered line and the request-killed line');
	const phpLine = lines.find((l) => l.includes('phpStatus'));
	const killedLine = lines.find((l) => l.includes("phase: 'request-killed'"));
	assert.ok(phpLine && killedLine);

	const lost = 1;
	const sql = "UPDATE `wp_postmeta` SET `meta_value` = 'secret@example.com'";
	const base = {
		req: post({ 'x-perf-id': PERF_ID, 'x-spike-token': TOKEN }),
		env: { SPIKE_TOKEN: TOKEN },
		url: { pathname: '/wp-admin/post.php' },
		lost,
		r: { httpStatusCode: 200 },
		d: { failures: [{ sql }] },
		sqlShape,
		memIdOf,
		kind: 'memory',
		wl: writeLossResponse(lost, wantsJson('/wp-admin/post.php', '', 'text/html')),
		ocForgot: { n: 3, groups: { 'post-queries': 3 } }, // #766
		rolled: null, // #794: no proven rollback in this case
	};
	const withId = logged(phpLine, base);
	assert.equal(withId.id, PERF_ID, 'a valid x-perf-id is on the line, got ' + JSON.stringify(withId));
	assert.equal(withId.answered, base.wl.status, 'answered is the status the client got');
	assert.equal(withId.answered, 500);
	assert.equal(withId.phpStatus, 200, 'phpStatus stays PHP own status, before the guard');
	assert.equal(withId.failed, lost);
	assert.equal(withId.ocDropped, 3, '#766: the line says how many of the request object-cache writes were dropped');
	assert.deepEqual(withId.ocDroppedGroups, { 'post-queries': 3 }, '#766: and in which groups');
	assert.equal(withId.rolledBack, false, '#794: the line says whether the frame was proven rolled back');
	assert.equal(withId.firstSql, 'UPDATE wp_postmeta');
	assert.equal(withId['@event'], 'write-loss');
	// 321 is not a real status: it proves the field is wl.status, not a hardcoded 500 and not phpStatus.
	assert.equal(logged(phpLine, { ...base, wl: { status: 321 } }).answered, 321);

	const noHeader = logged(phpLine, { ...base, req: post({ 'x-spike-token': TOKEN }) });
	assert.equal(Object.hasOwn(noHeader, 'id'), false, 'no id without x-perf-id, got ' + JSON.stringify(noHeader));
	assert.equal(noHeader.answered, base.wl.status);
	assert.equal(noHeader.phpStatus, 200);

	const visitor = logged(phpLine, { ...base, req: post({ 'x-perf-id': PERF_ID }), env: { SPIKE_TOKEN: TOKEN } });
	assert.equal(Object.hasOwn(visitor, 'id'), false, 'a visitor id is not logged');
	const unsafe = logged(phpLine, { ...base, req: post({ 'x-perf-id': 'not a safe id', 'x-spike-token': TOKEN }) });
	assert.equal(Object.hasOwn(unsafe, 'id'), false, 'an id outside MEM_ID_RE is not logged');
	const tooLong = logged(phpLine, { ...base, req: post({ 'x-perf-id': 'a'.repeat(65), 'x-spike-token': TOKEN }) });
	assert.equal(Object.hasOwn(tooLong, 'id'), false);
	const on = logged(phpLine, { ...base, req: post({ 'x-perf-id': PERF_ID }), env: { PERF_HEADERS: 'on' } });
	assert.equal(on.id, PERF_ID, 'PERF_HEADERS=on is the other operator path');

	for (const wl of [
		writeLossResponse('unknown', false, 'memory'),
		rolledBackResponse(true, 'storage', 2),
	]) {
		const killed = logged(killedLine, { ...base, wl, kind: wl.headers['x-isolate-reset'] });
		assert.equal(killed.answered, wl.status, 'the killed line answered matches the response');
		assert.equal(killed.phase, 'request-killed');
		assert.equal(killed.failed, 'unknown');
		assert.equal(Object.hasOwn(killed, 'phpStatus'), false, 'PHP never answered on this path');
		assert.equal(logged(killedLine, { ...base, wl: { status: 321 } }).answered, 321);
	}
	const killedId = logged(killedLine, base);
	assert.equal(killedId.id, PERF_ID);
	const killedNone = logged(killedLine, { ...base, req: post({ 'x-spike-token': TOKEN }) });
	assert.equal(Object.hasOwn(killedNone, 'id'), false);

	const guard = indexSrc.indexOf('const lost = resetFailures(d.failures);');
	const built = indexSrc.indexOf('const wl = writeLossResponse(lost', guard);
	const loggedAt = indexSrc.indexOf("'@event': 'write-loss'", built);
	assert.ok(built > guard && loggedAt > built, 'answered is computed before the PHP-path log line');
	assert.match(indexSrc, /return new Response\(wl\.body, \{ status: wl\.status, headers: wl\.headers \}\)/);

	const doc = readFileSync(new URL('../write-loss.mjs', import.meta.url), 'utf8');
	assert.match(doc, /phpStatus is PHP's own status/);
	assert.match(doc, /not the status the client got/);
});

test('#795 statementFailureResponse: never a plausible wrong answer; retryable only when nothing was saved', () => {
	const a = statementFailureResponse(1, false, false);
	assert.equal(a.status, 503, 'nothing saved: a retryable 503');
	assert.equal(a.headers['retry-after'], '5');
	assert.equal(a.headers['cache-control'], 'no-store');
	assert.equal(a.headers['x-sql-failure'], '1');
	assert.equal(a.headers['x-write-loss'], 'none');
	assert.ok(!('x-isolate-reset' in a.headers), 'it claims no isolate reset: there was none');
	assert.match(a.body, /Nothing was saved/);
	const b = statementFailureResponse(2, true, true);
	assert.equal(b.status, 500, 'a write may have been kept: a 500');
	assert.ok(!('retry-after' in b.headers), 'and no Retry-After: a blind retry could apply a kept write twice');
	assert.equal(b.headers['x-write-loss'], 'unknown');
	const j = JSON.parse(b.body);
	assert.equal(j.data.statementFailure, true);
	assert.equal(j.data.status, 500);
});

test('#795 index.js: any failed statement outside the setup endpoints is answered as a failure, after the reset branch', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const lost = src.indexOf('const lost = resetFailures(d.failures);');
	const any = src.indexOf('if (d.failures.length && !SETUP_PATHS.has(url.pathname)) {');
	const copy = src.indexOf('for (const [k, v] of Object.entries(r.headers))', lost);
	assert.ok(lost > 0 && any > lost && copy > any, 'after the reset branch, before PHP headers are copied');
	assert.match(src, /const SETUP_PATHS = new Set\(\['\/_install', '\/_activate'\]\);/, 'only the measured setup endpoints are excluded');
	assert.match(src.slice(any, copy), /readFailed\(d\.failures\)\) \{\s*try \{ rb = undoLog && sqlDb \? undoLog\.rollbackFrame/, 'a failed read of any class rolls the frame back');
	assert.match(src.slice(any, copy), /const saved = rb \? !frameProvesRollback\(fr\) : wrote;/, '"nothing saved" only on the proof, or when nothing was written');
});
