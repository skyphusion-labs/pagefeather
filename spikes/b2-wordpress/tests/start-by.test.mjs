// #708: a request still QUEUED in a PHP object when its caller has given up must never run (a checkout would commit
// after the shopper saw a failure). The object cannot rely on seeing the caller's abort (request.signal reaches a fetch
// handler only with enable_request_signal, and Cloudflare does not say a Durable Object sees its caller's stub.fetch
// abort). So the Worker stamps a start-by on each forwarded request, and the object sheds (never runs) a request not
// granted by then: the lock's pre-run shed is provably "not run". #703's deadline then bounds only started runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startByMs, objectShedPlan, startByResponse, START_BY_HEADER, CALL_HEADER } from '../start-by.mjs';

test('startByMs: the default is the deadline minus a run allowance (30 s, or a third of a short deadline)', () => {
	assert.equal(startByMs({}, 90000), 60000);
	assert.equal(startByMs({}, 30000), 20000);
	assert.equal(startByMs({}, 600000), 570000);
	assert.equal(startByMs({}, 0), 0, 'no deadline (an exempt path, or OBJECT_CALL_DEADLINE_S=off): no start-by');
});
test('startByMs: OBJECT_START_BY_S sets it (seconds), off turns it off, a bad value keeps the default', () => {
	assert.equal(startByMs({ OBJECT_START_BY_S: '45' }, 90000), 45000);
	assert.equal(startByMs({ OBJECT_START_BY_S: 'off' }, 90000), 0);
	for (const bad of ['', 'abc', '-5', '0', '1e9', '10s']) assert.equal(startByMs({ OBJECT_START_BY_S: bad }, 90000), 60000, bad);
	// A start-by later than the deadline would let the deadline catch a request that never started: it is clamped.
	assert.equal(startByMs({ OBJECT_START_BY_S: '120' }, 90000), 60000);
	assert.equal(startByMs({ OBJECT_START_BY_S: '45' }, 0), 0, 'no deadline: nothing to bound against');
});
test('objectShedPlan: no or a bad start-by header keeps the base shed (today)', () => {
	assert.deepEqual(objectShedPlan(null, 1000, 0), { refuseNow: false, shedMs: 0, byStartBy: false });
	assert.deepEqual(objectShedPlan('abc', 1000, 5000), { refuseNow: false, shedMs: 5000, byStartBy: false });
});
test('objectShedPlan: a start-by already past refuses at once; otherwise the remainder becomes the shed bound', () => {
	assert.deepEqual(objectShedPlan('1000', 1000, 0), { refuseNow: true, shedMs: 0, byStartBy: true });
	assert.deepEqual(objectShedPlan('900', 1000, 0), { refuseNow: true, shedMs: 0, byStartBy: true });
	assert.deepEqual(objectShedPlan('61000', 1000, 0), { refuseNow: false, shedMs: 60000, byStartBy: true });
	// With PHP_QUEUE_SHED_MS also set (#635), the tighter bound wins, and says which one it is.
	assert.deepEqual(objectShedPlan('61000', 1000, 30000), { refuseNow: false, shedMs: 30000, byStartBy: false });
	assert.deepEqual(objectShedPlan('11000', 1000, 30000), { refuseNow: false, shedMs: 10000, byStartBy: true });
});
test('startByResponse: a fast, retry-safe 503 that says the request was queued and never ran', async () => {
	const r = startByResponse();
	assert.equal(r.status, 503);
	assert.equal(r.headers.get('x-object-deadline'), 'queued');
	assert.equal(r.headers.get('x-write-loss'), 'none');
	assert.equal(r.headers.get('retry-after'), '5');
	assert.match(r.headers.get('cache-control') || '', /no-store/);
	assert.match(await r.text(), /try again/i);
});
test('the header names', () => {
	assert.equal(START_BY_HEADER, 'x-pf-start-by');
	assert.equal(CALL_HEADER, 'x-pf-call');
});
test('index.js wires it on both sides (index.js imports the wasm engine, so it cannot load here)', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	// Worker side: only the Worker sets the two headers (a client copy is always dropped), per forwarded request.
	assert.ok(/fwd\.headers\.delete\(START_BY_HEADER\)/.test(src) && /fwd\.headers\.delete\(CALL_HEADER\)/.test(src), 'the Worker drops client copies');
	assert.ok(/fwd\.headers\.set\(START_BY_HEADER,/.test(src) && /fwd\.headers\.set\(CALL_HEADER,/.test(src), 'the Worker sets both');
	// Object side: the plan decides before the lock, a past start-by never queues, and a start-by shed answers queued.
	assert.ok(/objectShedPlan\(/.test(src) && /startByResponse\(\)/.test(src), 'the object uses the plan and the queued answer');
	assert.ok(/req\.headers\.delete\(START_BY_HEADER\)/.test(src) && /req\.headers\.delete\(CALL_HEADER\)/.test(src), 'PHP never sees them');
	// The correlation id is on the Worker's overflow and deadline lines.
	assert.ok(/event: 'overflow', [^\n]*call:/.test(src), 'overflow line carries call');
	assert.ok(/m: 'object-deadline', [^\n]*call:/.test(src), 'deadline line carries call');
});
