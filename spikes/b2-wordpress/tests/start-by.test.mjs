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
	assert.equal(startByMs({}, 0), 0, 'no deadline (OBJECT_CALL_DEADLINE_S=off) and no explicit value: no start-by');
});
test('startByMs: OBJECT_START_BY_S sets it (seconds), off turns it off, a bad value keeps the default', () => {
	assert.equal(startByMs({ OBJECT_START_BY_S: '45' }, 90000), 45000);
	assert.equal(startByMs({ OBJECT_START_BY_S: 'off' }, 90000), 0);
	for (const bad of ['', 'abc', '-5', '0', '1e9', '10s']) assert.equal(startByMs({ OBJECT_START_BY_S: bad }, 90000), 60000, bad);
	// A start-by later than the deadline would let the deadline catch a request that never started: it is clamped.
	assert.equal(startByMs({ OBJECT_START_BY_S: '120' }, 90000), 60000);
	// #708 review 6: an explicit value stands on its own when #703's deadline is off (OBJECT_CALL_DEADLINE_S=off), so a
	// queued request still never runs after its caller gave up. With no deadline there is no ceiling to clamp to.
	assert.equal(startByMs({ OBJECT_START_BY_S: '45' }, 0), 45000, 'explicit, deadline off: honoured');
	assert.equal(startByMs({ OBJECT_START_BY_S: '700' }, 0), 0, 'a bad value with no deadline: none (still bounded to 600 s)');
	assert.equal(startByMs({}, 0), 0, 'deadline off and no explicit value: no start-by (unchanged)');
	assert.equal(startByMs({ OBJECT_START_BY_S: '45' }, 90000, { exempt: true }), 0, 'an exempt path (install, import, cron) never gets one');
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
	assert.equal(r.headers.get('cloudflare-cdn-cache-control'), 'no-store', 'review 3: noStoreAnywhere, never stored at the edge');
	assert.equal(r.headers.get('x-overloaded'), '1', 'review 4: overloaded, as phpShedResponse says');
	assert.match(await r.text(), /try again/i);
});
test('the header names', () => {
	assert.equal(START_BY_HEADER, 'x-pf-start-by');
	assert.equal(CALL_HEADER, 'x-pf-call');
});
test('index.js wires it on both sides (index.js imports the wasm engine, so it cannot load here)', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	// review 8: the Worker strips client copies of both headers on EVERY path, first thing in serve(), so neither the
	// object path nor the Worker's own PHP (WordPress would see HTTP_X_PF_*) ever gets a client's value.
	const serve = src.slice(src.indexOf('	async serve(req, env, ctx) {'), src.indexOf("if (url.pathname === '/_ping')"));
	assert.ok(/req\.headers\.has\(START_BY_HEADER\) \|\| req\.headers\.has\(CALL_HEADER\)/.test(serve) && /delete\(START_BY_HEADER\)/.test(serve) && /delete\(CALL_HEADER\)/.test(serve), 'serve() strips both first');
	// The forward sets the call id, and the start-by or none (review 9: no delete before a set).
	assert.ok(/fwd\.headers\.set\(CALL_HEADER, callId\);/.test(src), 'the forward carries the call id');
	assert.ok(/if \(startByQ > 0\) fwd\.headers\.set\(START_BY_HEADER, String\(t0 \+ startByQ\)\);\s*else fwd\.headers\.delete\(START_BY_HEADER\);/.test(src), 'a start-by, or none');
	assert.ok(!/fwd\.headers\.delete\(CALL_HEADER\);\s*fwd\.headers\.set\(CALL_HEADER/.test(src), 'review 9: no delete-then-set');
	// review 5: the client sees the call id on every answer of the object path (the wrapper tags what comes back).
	assert.ok(/async function toPhpObject\(req, env, url, ctx, target = null\) \{[\s\S]{0,400}withCallHeader\(/.test(src), 'toPhpObject tags its answer');
	// review 7: a request refused on arrival writes nothing: the refusal comes before the origin write and the cron rearm.
	const obj = src.slice(src.indexOf('	async fetch(raw) {'));
	const refuse = obj.indexOf('startByResponse()'); const write = obj.indexOf('this.ctx.storage.put(ORIGIN_KEY, origin)');
	assert.ok(refuse > 0 && write > 0 && refuse < write, 'the arrive-time refusal precedes any storage write');
	assert.ok(/objectShedPlan\(/.test(obj) && /req\.headers\.delete\(START_BY_HEADER\)/.test(obj) && /req\.headers\.delete\(CALL_HEADER\)/.test(obj), 'the object plans, and PHP never sees the headers');
	// review 2: the call id rides on the per-request ctx, not a module global (overlapping runs after a stale takeover).
	assert.ok(!/^let currentCall\b/m.test(src), 'no module-level currentCall');
	assert.ok(/ctx\.callId = callId/.test(obj) && /ctx && ctx\.callId \? \{ call: ctx\.callId \}/.test(src), 'perf reads ctx.callId');
	// The correlation id is on the Worker's overflow and deadline lines.
	assert.ok(/event: 'overflow', [^\n]*call:/.test(src), 'overflow line carries call');
	assert.ok(/m: 'object-deadline', [^\n]*call:/.test(src), 'deadline line carries call');
});
