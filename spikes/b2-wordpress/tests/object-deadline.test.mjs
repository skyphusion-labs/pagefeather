// node --test spikes/b2-wordpress/tests/object-deadline.test.mjs (#605)
// The front Worker must not wait out a PHP object that never starts answering.
// A fake PHP_RUNTIME stub that hangs is aborted at T and answered 503
// x-object-deadline. A stub that answers inside T is unchanged. An exempt
// path (install, import, sqlimport, cron) is not cut. A method that may
// have written gets the write-loss answer, never "nothing was saved".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WRITE_LOSS_CODE, WRITE_LOSS_MESSAGE, ROLLED_BACK_MESSAGE } from '../write-loss.mjs';
import { classifyObjectError } from '../object-error.mjs';

async function load() {
	return import('../object-deadline.mjs');
}

// A stub whose fetch settles only if the request signal aborts, or after delayMs.
function fakeStub({ delayMs = null, status = 200, body = 'ok', headers = {} } = {}) {
	let aborted = 0;
	let fetches = 0;
	const stub = {
		fetch(request) {
			fetches++;
			return new Promise((resolve, reject) => {
				let timer = null;
				if (delayMs !== null) {
					timer = setTimeout(() => resolve(new Response(body, { status, headers })), delayMs);
				}
				const stop = () => {
					aborted++;
					if (timer) clearTimeout(timer);
					reject(new DOMException('The operation was aborted', 'AbortError'));
				};
				if (request.signal) {
					if (request.signal.aborted) stop();
					else request.signal.addEventListener('abort', stop, { once: true });
				}
			});
		},
	};
	return {
		stub,
		get aborted() { return aborted; },
		get fetches() { return fetches; },
	};
}

function runtimeOf(stub) {
	return {
		idFromName(name) { return 'id:' + name; },
		get(id) { runtimeOf.last = id; return stub; },
	};
}

// Fail the test if the call is still open after this, so a missing deadline
// cannot sit until a default of many seconds.
async function within(ms, fn) {
	let timer;
	try {
		return await Promise.race([
			fn(),
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('hung past ' + ms + ' ms')), ms); }),
		]);
	} finally {
		clearTimeout(timer);
	}
}

const EXEMPT = ['/_install', '/_activate', '/_sqlimport', '/_dbimport', '/_runcron', '/wp-cron.php'];

test('OBJECT_CALL_DEADLINE_S defaults to 90 s, and a bad value keeps that default', async () => {
	const { DEFAULT_OBJECT_CALL_DEADLINE_S, objectCallDeadlineMs, objectCallExempt, OBJECT_CALL_EXEMPT_PATHS } = await load();
	assert.equal(DEFAULT_OBJECT_CALL_DEADLINE_S, 90);
	assert.equal(objectCallDeadlineMs({}), 90000);
	assert.equal(objectCallDeadlineMs({ OBJECT_CALL_DEADLINE_S: '12' }), 12000);
	assert.equal(objectCallDeadlineMs({ OBJECT_CALL_DEADLINE_S: '0.05' }), 50);
	assert.equal(objectCallDeadlineMs({ OBJECT_CALL_DEADLINE_S: 'off' }), 0);
	assert.equal(objectCallDeadlineMs({ OBJECT_CALL_DEADLINE_S: 'nope' }), 90000);
	assert.equal(objectCallDeadlineMs({ OBJECT_CALL_DEADLINE_S: '0' }), 90000);
	assert.equal(objectCallDeadlineMs({ OBJECT_CALL_DEADLINE_S: '601' }), 90000);
	assert.deepEqual([...OBJECT_CALL_EXEMPT_PATHS], EXEMPT);
	for (const p of EXEMPT) assert.equal(objectCallExempt(p), true, p);
	assert.equal(objectCallExempt('/wp-admin/profile.php'), false);
	assert.equal(objectCallExempt('/wp-admin/post-new.php'), false);
	assert.equal(objectCallExempt('/_install/extra'), false);
});

test('a PHP_RUNTIME stub that never answers is aborted within T and answered 503 x-object-deadline', async () => {
	const { callPhpObject, objectCallDeadlineMs, isObjectCallDeadline } = await load();
	const hang = fakeStub();
	const env = { PHP_RUNTIME: runtimeOf(hang.stub), OBJECT_CALL_DEADLINE_S: '0.05' };
	const name = 'php-0';
	const stub = env.PHP_RUNTIME.get(env.PHP_RUNTIME.idFromName(name));
	assert.equal(runtimeOf.last, 'id:php-0');
	const deadlineMs = objectCallDeadlineMs(env);
	assert.equal(deadlineMs, 50);
	const ac = new AbortController();
	const req = new Request('https://site.test/wp-admin/post-new.php', { signal: ac.signal });
	const t0 = Date.now();
	const e = await within(1000, () => callPhpObject(stub, req, {
		deadlineMs,
		controller: ac,
		method: 'GET',
		objectName: name,
		json: false,
	}).then(() => { throw new Error('the hanging stub resolved'); }, (err) => err));
	const elapsed = Date.now() - t0;
	assert.ok(isObjectCallDeadline(e), 'deadline error, not a hang and not a generic throw');
	assert.ok(elapsed < 1000, 'answered within 1 s, not the 90 s default: ' + elapsed);
	assert.ok(elapsed >= 40, 'did not answer before T: ' + elapsed);
	assert.equal(hang.aborted, 1, 'the in-flight stub.fetch was aborted');
	assert.equal(hang.fetches, 1);
	const r = e.response;
	assert.equal(r.status, 503);
	assert.equal(r.headers.get('x-object-deadline'), 'no-answer');
	assert.equal(r.headers.get('retry-after'), '5');
	assert.equal(r.headers.get('cache-control'), 'no-store');
	assert.equal(r.headers.get('x-php-object'), name);
	assert.equal(r.headers.get('x-write-loss'), null);
	assert.equal(r.headers.get('x-isolate-reset'), null);
	assert.equal(r.headers.get('x-overloaded'), null);
	assert.match(await r.text(), /try again/);
	assert.equal(classifyObjectError(e), null, 'a deadline is not a reset and not a full queue, so it is not retried');
	assert.doesNotMatch(e.message, /memory limit|overloaded|storage caused object to be reset/);
});

test('a stub that answers inside T is unchanged', async () => {
	const { callPhpObject } = await load();
	const quick = fakeStub({
		delayMs: 20,
		status: 200,
		body: 'page-body',
		headers: { 'x-from-object': '1', 'x-perf': '{"phpMs":10}' },
	});
	const ac = new AbortController();
	const req = new Request('https://site.test/wp-admin/index.php', { signal: ac.signal });
	const t0 = Date.now();
	const r = await within(1000, () => callPhpObject(quick.stub, req, {
		deadlineMs: 400,
		controller: ac,
		method: 'GET',
		objectName: 'php-0',
		json: false,
	}));
	assert.ok(Date.now() - t0 < 400);
	assert.equal(r.status, 200);
	assert.equal(await r.text(), 'page-body');
	assert.equal(r.headers.get('x-from-object'), '1');
	assert.equal(r.headers.get('x-perf'), '{"phpMs":10}');
	assert.equal(r.headers.get('x-object-deadline'), null);
	assert.equal(r.headers.get('x-write-loss'), null);
	assert.equal(quick.aborted, 0);
	assert.equal(quick.fetches, 1);
});

test('an exempt path is not cut when it runs longer than T', async () => {
	const { callPhpObject, objectCallExempt, objectCallDeadlineMs } = await load();
	const slow = fakeStub({ delayMs: 180, status: 200, body: 'imported', headers: { 'x-import': '1' } });
	const env = { OBJECT_CALL_DEADLINE_S: '0.05' };
	const tiny = objectCallDeadlineMs(env);
	assert.equal(tiny, 50);
	assert.equal(objectCallExempt('/_sqlimport'), true);
	const deadlineMs = objectCallExempt('/_sqlimport') ? 0 : tiny;
	const req = new Request('https://site.test/_sqlimport', { method: 'POST', body: 'INSERT' });
	const t0 = Date.now();
	const r = await within(1000, () => callPhpObject(slow.stub, req, {
		deadlineMs,
		method: 'POST',
		objectName: 'php-0',
		json: false,
	}));
	const elapsed = Date.now() - t0;
	assert.ok(elapsed >= 150, 'waited for the stub, not the tiny deadline: ' + elapsed);
	assert.equal(r.status, 200);
	assert.equal(await r.text(), 'imported');
	assert.equal(r.headers.get('x-import'), '1');
	assert.equal(r.headers.get('x-object-deadline'), null);
	assert.equal(slow.aborted, 0);
	assert.equal(slow.fetches, 1);

	// The same slow stub on a normal admin path IS cut, so the exempt result
	// is the exemption and not a stub that answers immediately.
	const cut = fakeStub({ delayMs: 180, status: 200, body: 'late' });
	const ac = new AbortController();
	const admin = new Request('https://site.test/wp-admin/profile.php', { method: 'GET', signal: ac.signal });
	const e = await within(1000, () => callPhpObject(cut.stub, admin, {
		deadlineMs: tiny,
		controller: ac,
		method: 'GET',
		objectName: 'php-0',
		json: false,
	}).then(() => { throw new Error('late admin stub was not cut'); }, (err) => err));
	assert.equal(e.response.status, 503);
	assert.equal(e.response.headers.get('x-object-deadline'), 'no-answer');
	assert.equal(cut.aborted, 1);
});

test('a method that may have written gets write-loss, and does not say nothing was saved', async () => {
	const { callPhpObject, isObjectCallDeadline } = await load();
	const hang = fakeStub();
	const ac = new AbortController();
	const req = new Request('https://site.test/wp-admin/profile.php', {
		method: 'POST',
		body: 'email=a',
		headers: { accept: 'application/json' },
		signal: ac.signal,
	});
	const e = await within(1000, () => callPhpObject(hang.stub, req, {
		deadlineMs: 50,
		controller: ac,
		method: 'POST',
		objectName: 'php-0',
		json: true,
		pfReq: 'req-1',
	}).then(() => { throw new Error('the hanging POST resolved'); }, (err) => err));
	assert.ok(isObjectCallDeadline(e));
	assert.equal(hang.aborted, 1);
	const r = e.response;
	assert.equal(r.status, 500);
	assert.equal(r.headers.get('x-write-loss'), 'unknown');
	assert.equal(r.headers.get('x-object-deadline'), 'no-answer');
	assert.equal(r.headers.get('x-php-object'), 'php-0');
	assert.equal(r.headers.get('x-pf-req'), 'req-1');
	assert.equal(r.headers.get('retry-after'), null, 'no Retry-After: a blind retry could repeat a write');
	assert.equal(r.headers.get('x-isolate-reset'), null, 'a deadline is not claimed to be an isolate reset');
	assert.equal(r.headers.get('cache-control'), 'no-store');
	assert.match(r.headers.get('content-type'), /application\/json/);
	const d = JSON.parse(await r.text());
	assert.equal(d.code, WRITE_LOSS_CODE);
	assert.equal(d.message, WRITE_LOSS_MESSAGE);
	assert.doesNotMatch(d.message, /Nothing was saved/);
	assert.notEqual(d.message, ROLLED_BACK_MESSAGE);
	assert.equal(d.data.rolledBack, undefined);

	// OPTIONS writes nothing (object-error.mjs), so it stays a 503.
	const { objectDeadlineAnswer } = await load();
	const opt = objectDeadlineAnswer({ method: 'OPTIONS', objectName: 'php-0', json: false });
	assert.equal(opt.status, 503);
	assert.equal(opt.headers['x-write-loss'], undefined);
	assert.equal(opt.headers['retry-after'], '5');
});

test('an object reset still rejects with the platform error', async () => {
	const { callPhpObject } = await load();
	const err = Object.assign(new Error("Durable Object's isolate exceeded its memory limit and was reset."), { overloaded: true });
	const stub = { fetch() { return Promise.reject(err); } };
	const ac = new AbortController();
	const req = new Request('https://site.test/wp-admin/', { signal: ac.signal });
	await assert.rejects(
		() => callPhpObject(stub, req, { deadlineMs: 1000, controller: ac, method: 'GET', objectName: 'php-0', json: false }),
		(e) => e === err,
	);
});

test('index.js applies the deadline inside toPhpObject and returns it before any frame probe', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{ callPhpObject, isObjectCallDeadline, objectCallDeadlineMs, objectCallExempt \} from '\.\/object-deadline\.mjs';/);
	const fnStart = src.indexOf('async function toPhpObjectCall(') /* #708: the body behind the toPhpObject wrapper */;
	const fn = src.slice(fnStart, src.indexOf('\n}\n', fnStart));
	assert.match(fn, /const objectDeadlineMs = objectCallExempt\(url\.pathname\) \? 0 : objectCallDeadlineMs\(env\);/);
	assert.match(fn, /return callPhpObject\(stub, sent,/);
	assert.match(fn, /object-deadline-retry/);
	assert.match(fn, /if \(res\.deadline\) \{/);
	assert.match(fn, /m: 'object-deadline'/);
	assert.match(fn, /\.\.\.memIdOf\(req, env\)/);
	// /_frame probes before the PHP call. The write-loss probe is the one that
	// must not run after a deadline: it is another stub.fetch to the same object.
	const back = fn.indexOf('if (res.deadline) {');
	const probe = fn.indexOf('frameProbe(', back);
	assert.ok(back > 0 && probe > back, 'the deadline answer returns before the write-loss frame probe');
	// The Turnstile header is still set on the forwarded request, then the deadline wraps it.
	assert.match(fn, /const fwd = attemptRequest\(req, replay\);\s*\/\/[^\n]*\n\s*setResultHeader\(fwd\.headers, pre && pre\.value\);/);
	assert.ok(fn.indexOf('const sent = ac ? new Request(fwd, { signal: ac.signal }) : fwd;') > fn.indexOf('setResultHeader(fwd.headers, pre && pre.value);'));
});
