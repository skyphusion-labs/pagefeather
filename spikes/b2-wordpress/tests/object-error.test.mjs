// Tests of object-error.mjs (issue #335): an isolate memory reset is not a full queue.
// The messages are the platform's own, from Workers Logs on fdprobe1112g (2026-11-12) and
// docs/perf-dosql.md (2026-11-05).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyObjectError, objectErrorHeaders, shouldRetryObjectError, shouldRetryObjectDeadline, isObjectCallDeadlineError, fetchWithMemoryRetry } from '../object-error.mjs';

const reset = Object.assign(new Error("Durable Object's isolate exceeded its memory limit and was reset."), { overloaded: true });
const queue = Object.assign(new Error('Durable Object is overloaded. Too many requests queued.'), { overloaded: true });

test('a memory reset is memory, also with e.overloaded set (as the platform sends it)', () => {
	assert.equal(classifyObjectError(reset), 'memory');
});

test('a full queue is overloaded, by the flag or by the message', () => {
	assert.equal(classifyObjectError(queue), 'overloaded');
	assert.equal(classifyObjectError(new Error('Durable Object is overloaded.')), 'overloaded');
	assert.equal(classifyObjectError({ overloaded: true, message: 'x' }), 'overloaded');
});

test('anything else is not classified (the caller throws it as before)', () => {
	assert.equal(classifyObjectError(new Error('Network connection lost.')), null);
	assert.equal(classifyObjectError(undefined), null);
});

test('the headers name the kind: x-isolate-reset for memory, x-overloaded for a queue, never both', () => {
	const m = objectErrorHeaders('memory', 'php-0', '5');
	assert.equal(m['x-isolate-reset'], 'memory');
	assert.equal(m['x-overloaded'], undefined);
	const o = objectErrorHeaders('overloaded', 'php-0', '5');
	assert.equal(o['x-overloaded'], '1');
	assert.equal(o['x-isolate-reset'], undefined);
	for (const h of [m, o]) {
		assert.equal(h['cache-control'], 'no-store');
		assert.equal(h['retry-after'], '5');
	}
});

test('index.js answers through fetchWithMemoryRetry, and never tags a memory reset x-overloaded', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	// #398: the write-loss decision is objectErrorOutcome (it holds #350's mayHaveWritten), and isResetKind names the log line.
	assert.match(src, /import \{ classifyObjectError, objectErrorHeaders, fetchWithMemoryRetry, isResetKind, objectErrorOutcome \} from '\.\/object-error\.mjs';/);
	const i = src.indexOf('async function toPhpObjectCall(') /* #708: the body behind the toPhpObject wrapper */;
	const body = src.slice(i, src.indexOf('\n}\n', i));
	assert.match(body, /const res = await fetchWithMemoryRetry\(/);
	assert.match(body, /req\.method,/, 'the retry decision gets the request method');
	// A stub per attempt: the stub is made inside the send function, not before it.
	const send = body.indexOf('fetchWithMemoryRetry(');
	assert.ok(body.indexOf('env.PHP_RUNTIME.get(', send) > send, 'the stub is made inside send');
	assert.ok(body.indexOf('env.PHP_RUNTIME.get(') > send, 'no stub is made before send');
	assert.match(body, /headers: objectErrorHeaders\(kind, name, OVERLOAD_RETRY_AFTER_S\)|const headers = objectErrorHeaders\(kind, name, OVERLOAD_RETRY_AFTER_S\);/);
	assert.match(body, /if \(retried\) out\.headers\.set\('x-isolate-retry', '1'\);/);
	assert.doesNotMatch(body, /'x-overloaded': '1'/, 'the literal tag lives in objectErrorHeaders');
});

// The retry (#335, the lead's ruling): once, only a memory reset, only a GET or HEAD.
test('shouldRetryObjectError: a memory reset on the first GET or HEAD only', () => {
	assert.equal(shouldRetryObjectError('memory', 'GET', 0), true);
	assert.equal(shouldRetryObjectError('memory', 'head', 0), true);
	for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', '', undefined]) assert.equal(shouldRetryObjectError('memory', m, 0), false, String(m));
	assert.equal(shouldRetryObjectError('memory', 'GET', 1), false, 'never a second retry');
	assert.equal(shouldRetryObjectError('overloaded', 'GET', 0), false, 'never into a full queue');
	assert.equal(shouldRetryObjectError(null, 'GET', 0), false);
});

// A fake stub: each call takes the next outcome (an Error to throw, or a value to return).
function fake(...outcomes) {
	const calls = [];
	return { calls, send: async (attempt) => { calls.push(attempt); const o = outcomes[calls.length - 1]; if (o instanceof Error) throw o; return o; } };
}

test('the reproduction: a GET that dies in a memory reset is answered by the second attempt', async () => {
	const f = fake(reset, 'page');
	const retries = [];
	const res = await fetchWithMemoryRetry(f.send, 'GET', (e, a) => retries.push(a));
	assert.deepEqual(res, { r: 'page', attempts: 2 });
	assert.deepEqual(f.calls, [0, 1]);
	assert.deepEqual(retries, [0]);
});

test('a POST that dies in a memory reset is NOT retried', async () => {
	const f = fake(reset, 'page');
	const res = await fetchWithMemoryRetry(f.send, 'POST');
	assert.equal(res.kind, 'memory');
	assert.equal(res.attempts, 1);
	assert.deepEqual(f.calls, [0], 'sent once');
});

// #589 (the lead's ruling): OPTIONS is a safe method like GET and HEAD (WordPress answers it from the
// route schema). In the block editor round, 5 OPTIONS /wp/v2/... died in a memory reset and each got
// the write-loss 500 "may have been saved", though it writes nothing. Now it is retried once, and a
// reset it cannot outlive is the 503, never the write-loss answer.
test('#589: an OPTIONS that dies in a reset is retried once and answered by the second attempt', async () => {
	for (const err of [reset, new Error('Internal error in Durable Object storage caused object to be reset; reference = abc')]) {
		const f = fake(err, 'schema');
		assert.deepEqual(await fetchWithMemoryRetry(f.send, 'OPTIONS'), { r: 'schema', attempts: 2 });
		assert.deepEqual(f.calls, [0, 1]);
	}
	assert.equal(shouldRetryObjectError('memory', 'OPTIONS', 0), true);
	assert.equal(shouldRetryObjectError('storage', 'options', 0), true, 'case-insensitive, like GET');
	assert.equal(shouldRetryObjectError('memory', 'OPTIONS', 1), false, 'never a second retry');
	assert.equal(shouldRetryObjectError('overloaded', 'OPTIONS', 0), false, 'never into a full queue');
});

test('#589: an OPTIONS that dies twice is the 503, never the write-loss 500', async () => {
	const f = fake(reset, reset);
	const res = await fetchWithMemoryRetry(f.send, 'OPTIONS');
	assert.equal(res.kind, 'memory');
	assert.deepEqual(f.calls, [0, 1]);
	assert.equal(objectErrorOutcome(res.kind, 'OPTIONS'), '503');
	assert.equal(mayHaveWritten('OPTIONS'), false);
});

test('a GET that dies twice is answered with the memory 503 after one retry, never a third send', async () => {
	const f = fake(reset, reset, 'page');
	const res = await fetchWithMemoryRetry(f.send, 'GET');
	assert.equal(res.kind, 'memory');
	assert.equal(res.attempts, 2);
	assert.deepEqual(f.calls, [0, 1]);
});

test('a full queue is not retried, and an unknown error is thrown as before', async () => {
	const q = fake(queue, 'page');
	const res = await fetchWithMemoryRetry(q.send, 'GET');
	assert.equal(res.kind, 'overloaded');
	assert.deepEqual(q.calls, [0]);
	const u = fake(new Error('Network connection lost.'));
	await assert.rejects(fetchWithMemoryRetry(u.send, 'GET'), /Network connection lost/);
	assert.deepEqual(u.calls, [0]);
});

test('an answer on the first attempt is one send', async () => {
	const f = fake('page');
	assert.deepEqual(await fetchWithMemoryRetry(f.send, 'GET'), { r: 'page', attempts: 1 });
});


function deadlineErr() {
	const e = new Error('PHP object did not start answering within 90 ms');
	e.deadline = true;
	e.deadlineMs = 90;
	e.response = new Response('no', { status: 503, headers: { 'x-object-deadline': 'no-answer' } });
	return e;
}

test('#605: a GET that hits the object-call deadline is retried once, then answered', async () => {
	const f = fake(deadlineErr(), 'page');
	const res = await fetchWithMemoryRetry(f.send, 'GET');
	assert.equal(res.r, 'page');
	assert.equal(res.attempts, 2);
	assert.deepEqual(f.calls, [0, 1]);
});

test('#605: a POST deadline is not retried', async () => {
	const res = await fetchWithMemoryRetry(fake(deadlineErr()).send, 'POST');
	assert.equal(res.deadline.status, 503);
	assert.equal(res.attempts, 1);
});

test('#605: shouldRetryObjectDeadline matches safe methods only', () => {
	assert.equal(shouldRetryObjectDeadline('GET', 0), true);
	assert.equal(shouldRetryObjectDeadline('POST', 0), false);
	assert.equal(shouldRetryObjectDeadline('GET', 1), false);
	assert.ok(isObjectCallDeadlineError(deadlineErr()));
});

// #398: a Durable Object storage reset. The message is the platform's own, from Workers Logs for
// site-tsv1113w (2026-11-13, 10:53:48.563Z); the reference id changes on every reset.
import { objectErrorOutcome, isResetKind, STORAGE_RESET, mayHaveWritten } from '../object-error.mjs';
const storage = new Error('Internal error in Durable Object storage caused object to be reset; reference = 6voil23sc4636vq005nmetul');
const storageOther = new Error('Internal error in Durable Object storage caused object to be reset; reference = zz00aa11bb22cc33dd44ee55');
const unknown = new Error('Network connection lost.');

test('THE TSV1113W CASE: a storage reset is classified storage, whatever its reference id', () => {
	assert.equal(classifyObjectError(storage), 'storage');
	assert.equal(classifyObjectError(storageOther), 'storage');
	assert.equal(classifyObjectError('Internal error in Durable Object storage caused object to be reset'), 'storage', 'no reference at all');
	assert.equal(classifyObjectError(Object.assign(new Error(storage.message), { overloaded: true })), 'storage', 'a reset, also if the platform sets e.overloaded');
	assert.doesNotMatch(STORAGE_RESET.source, /reference|6voil/, 'the match is on the stable text, never the id');
});

test('each class maps to its kind: memory, storage, overloaded, unknown', () => {
	assert.equal(classifyObjectError(reset), 'memory');
	assert.equal(classifyObjectError(storage), 'storage');
	assert.equal(classifyObjectError(queue), 'overloaded');
	assert.equal(classifyObjectError(unknown), null);
	assert.equal(isResetKind('memory'), true);
	assert.equal(isResetKind('storage'), true);
	assert.equal(isResetKind('overloaded'), false);
	assert.equal(isResetKind(null), false);
});

test('objectErrorOutcome: a reset on a method that may have written is the write-loss 500, else the 503', () => {
	for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
		assert.equal(objectErrorOutcome('memory', m), 'write-loss', 'memory ' + m);
		assert.equal(objectErrorOutcome('storage', m), 'write-loss', 'storage ' + m);
		assert.equal(objectErrorOutcome('overloaded', m), '503', 'a full queue never ran the request: overloaded ' + m);
	}
	for (const m of ['GET', 'HEAD', 'OPTIONS']) {
		assert.equal(objectErrorOutcome('memory', m), '503', 'memory ' + m);
		assert.equal(objectErrorOutcome('storage', m), '503', 'storage ' + m);
		assert.equal(objectErrorOutcome('overloaded', m), '503', 'overloaded ' + m);
	}
});

test('a storage reset: x-isolate-reset: storage, never x-overloaded', () => {
	const h = objectErrorHeaders('storage', 'php-0', '5');
	assert.equal(h['x-isolate-reset'], 'storage');
	assert.equal(h['x-overloaded'], undefined);
	assert.equal(h['cache-control'], 'no-store');
});

test('shouldRetryObjectError: a storage reset on the first GET or HEAD only, like memory', () => {
	assert.equal(shouldRetryObjectError('storage', 'GET', 0), true);
	assert.equal(shouldRetryObjectError('storage', 'HEAD', 0), true);
	for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(shouldRetryObjectError('storage', m, 0), false, m);
	assert.equal(shouldRetryObjectError('storage', 'GET', 1), false, 'never a second retry');
});

test('a GET that dies in a storage reset is answered by the second attempt; a POST is sent once and comes back as storage', async () => {
	const g = fake(storage, 'page');
	assert.deepEqual(await fetchWithMemoryRetry(g.send, 'GET'), { r: 'page', attempts: 2 });
	assert.deepEqual(g.calls, [0, 1]);
	const p = fake(storage, 'page');
	const res = await fetchWithMemoryRetry(p.send, 'POST');
	assert.equal(res.kind, 'storage');
	assert.equal(res.attempts, 1);
	assert.deepEqual(p.calls, [0], 'a POST is never sent twice');
	assert.equal(objectErrorOutcome(res.kind, 'POST'), 'write-loss', 'the 500, never the dispatcher 502');
	const d = fake(storage, storage, 'page');
	const res2 = await fetchWithMemoryRetry(d.send, 'GET');
	assert.equal(res2.kind, 'storage');
	assert.deepEqual(d.calls, [0, 1], 'one retry, never a third send');
	assert.equal(objectErrorOutcome(res2.kind, 'GET'), '503');
});

test('an unknown error is still thrown, for every method (the #398 fix classifies only the storage reset)', async () => {
	for (const m of ['GET', 'POST']) {
		const u = fake(unknown, 'page');
		await assert.rejects(fetchWithMemoryRetry(u.send, m), /Network connection lost/);
		assert.deepEqual(u.calls, [0], m + ' is not retried');
	}
	const other = fake(new Error('Internal error in Durable Object storage.'), 'page');
	await assert.rejects(fetchWithMemoryRetry(other.send, 'POST'), /Durable Object storage/, 'a storage error that is not a reset is not a reset');
});

test('index.js toPhpObject: the storage kind reaches the log line and the write-loss answer', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const i = src.indexOf('async function toPhpObjectCall(') /* #708: the body behind the toPhpObject wrapper */;
	const body = src.slice(i, src.indexOf('\n}\n', i));
	assert.match(body, /const reset = isResetKind\(kind\);/);
	assert.match(body, /const tag = reset \? 'isolate-reset' : kind === 'internal' \? 'platform-internal' : 'overloaded';/);
	assert.match(body, /m: tag, kind,/, 'logged with its kind, so it is counted');
	assert.match(body, /if \(objectErrorOutcome\(kind, req\.method\) === 'write-loss'\) \{/);
	assert.match(body, /writeLossResponse\('unknown', wantsJson\(url\.pathname, url\.search, req\.headers\.get\('accept'\)\), kind\);/, 'the 500 names the reset kind');
	assert.match(body, /The site had an internal error\./);
	assert.match(body, /The site restarted\./);
});

// #976: the platform message, from Workers Logs for site-cf759a (2026-11-19, 14:19:16.887Z).
// The reference id changes on every throw. The storage-reset sentence stays storage.
import { PLATFORM_INTERNAL } from '../object-error.mjs';
const platformInternal = new Error('internal error; reference = 90uegpepiv0mtmldgmi75dvu');
const platformInternalOther = new Error('internal error; reference = q107v5lm1joquvq82v55uv8p');

test('THE CF759A CASE: a platform internal error is internal, whatever its reference id', () => {
	assert.equal(classifyObjectError(platformInternal), 'internal');
	assert.equal(classifyObjectError(platformInternalOther), 'internal');
	assert.equal(classifyObjectError(new Error('Internal error; reference = abc')), 'internal');
	assert.equal(classifyObjectError(storage), 'storage', 'the storage reset sentence stays storage');
	assert.equal(classifyObjectError(new Error('internal error')), null, 'a bare internal error is not this');
	assert.equal(classifyObjectError(new Error('internal error; reference = has space')), null);
	assert.doesNotMatch(PLATFORM_INTERNAL.source, /90uegpe|q107v5/, 'the match is on the stable text, never the id');
	assert.equal(isResetKind('internal'), false, 'this message does not say the object was reset');
});

test('a platform internal error is a 503 the client can retry, never a write-loss and never a second send', async () => {
	assert.equal(objectErrorOutcome('internal', 'POST'), '503');
	assert.equal(objectErrorOutcome('internal', 'GET'), '503');
	assert.equal(shouldRetryObjectError('internal', 'GET', 0), false, 'a retry adds load to a platform fault');
	assert.equal(shouldRetryObjectError('internal', 'POST', 0), false);
	const h = objectErrorHeaders('internal', 'php-0', '5');
	assert.equal(h['x-platform-error'], 'internal');
	assert.equal(h['x-overloaded'], undefined);
	assert.equal(h['x-isolate-reset'], undefined);
	assert.equal(h['cache-control'], 'no-store');
	assert.equal(h['retry-after'], '5');
	const p = fake(platformInternal, 'page');
	const res = await fetchWithMemoryRetry(p.send, 'POST');
	assert.equal(res.kind, 'internal');
	assert.equal(res.attempts, 1);
	assert.deepEqual(p.calls, [0], 'a POST is never sent twice');
	const g = fake(platformInternal, 'page');
	const res2 = await fetchWithMemoryRetry(g.send, 'GET');
	assert.equal(res2.kind, 'internal');
	assert.deepEqual(g.calls, [0], 'a GET is not retried into a platform fault');
});
