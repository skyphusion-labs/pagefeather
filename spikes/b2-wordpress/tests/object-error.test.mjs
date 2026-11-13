// Tests of object-error.mjs (issue #335): an isolate memory reset is not a full queue.
// The messages are the platform's own, from Workers Logs on fdprobe1112g (2026-11-12) and
// docs/perf-dosql.md (2026-11-05).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyObjectError, objectErrorHeaders, shouldRetryObjectError, fetchWithMemoryRetry } from '../object-error.mjs';

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
	const i = src.indexOf('async function toPhpObject(');
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
	for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '', undefined]) assert.equal(shouldRetryObjectError('memory', m, 0), false, String(m));
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

// #398: a Durable Object storage reset. The message is the platform's own, from Workers Logs for
// site-tsv1113w (2026-11-13, 10:53:48.563Z); the reference id changes on every reset.
import { objectErrorOutcome, isResetKind, STORAGE_RESET } from '../object-error.mjs';
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
	for (const m of ['GET', 'HEAD']) {
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
	const i = src.indexOf('async function toPhpObject(');
	const body = src.slice(i, src.indexOf('\n}\n', i));
	assert.match(body, /const reset = isResetKind\(kind\);/);
	assert.match(body, /m: reset \? 'isolate-reset' : 'overloaded', kind,/, 'logged as isolate-reset with its kind, so it is counted');
	assert.match(body, /if \(objectErrorOutcome\(kind, req\.method\) === 'write-loss'\) \{/);
	assert.match(body, /writeLossResponse\('unknown', wantsJson\(url\.pathname, url\.search, req\.headers\.get\('accept'\)\), kind\);/, 'the 500 names the reset kind');
	assert.match(body, /new Response\(reset \? 'The site restarted\./);
});
