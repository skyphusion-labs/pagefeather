// node --test spikes/b2-wordpress/tests/connector.test.mjs (#1101)
// cf759hx (approach A, Hyperdrive, checkout load arm 1): one add-to-cart answered the named retryable 503 after a Hyperdrive
// "Network connect..." failure, with x-sql-failure 17. mysql-bridge.js cached the connect promise and never cleared it on a
// REJECTION, so one transient connect failure failed every later statement of the run (17 of 17), though none had run.
// connector.mjs: a rejected connect is cleared and retried once, so a transient failure costs one reconnect. A connect
// failure means no statement ran, so nothing was written. If the retry fails too, the error stands (the named 503).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnector } from '../connector.mjs';

const conn = (n) => ({ id: n, end: async () => {} });

test('RED (cf759hx): with the old cache, one connect rejection fails every later query of the run', async () => {
	let calls = 0;
	const factory = async () => { calls++; throw new Error('Network connection lost.'); };
	let connecting = null;
	const old = () => (connecting ??= factory());
	for (let i = 0; i < 17; i++) await assert.rejects(old());
	assert.equal(calls, 1, 'one connect attempt, 17 failed statements: the bug');
});
test('a transient connect failure is retried once and the run proceeds', async () => {
	let calls = 0;
	const c = createConnector(async () => { calls++; if (calls === 1) throw new Error('Network connection lost.'); return conn(calls); });
	const got = await c.get();
	assert.equal(got.id, 2);
	assert.equal(calls, 2);
	assert.equal((await c.get()).id, 2, 'cached after success: no third connect');
	assert.equal(calls, 2);
});
test('two failures in a row: the error stands (the named 503), bounded at two attempts per get', async () => {
	let calls = 0;
	const c = createConnector(async () => { calls++; throw new Error('Network connection lost.'); });
	await assert.rejects(c.get(), /Network connection lost/);
	assert.equal(calls, 2);
	await assert.rejects(c.get(), /Network connection lost/, 'a later statement tries again (not poisoned)');
	assert.equal(calls, 4);
});
test('concurrent gets share one connect (no second socket for the same run)', async () => {
	let calls = 0;
	const c = createConnector(async () => { calls++; await new Promise((ok) => setTimeout(ok, 5)); return conn(calls); });
	const [a, b] = await Promise.all([c.get(), c.get()]);
	assert.equal(a, b);
	assert.equal(calls, 1);
});
test('reset forgets the connection without touching it; end closes it and forgets it first', async () => {
	let ended = 0, calls = 0;
	const c = createConnector(async () => { calls++; return { id: calls, end: async () => { ended++; } }; });
	await c.get();
	c.reset();
	assert.equal(ended, 0, 'reset never touches another context socket');
	assert.equal((await c.get()).id, 2);
	await c.end();
	assert.equal(ended, 1);
	assert.equal((await c.get()).id, 3, 'end cleared the reference before closing');
});
test('end of a connect still in flight closes it once it lands; a failed one is ignored', async () => {
	let ended = 0;
	const c = createConnector(async () => ({ end: async () => { ended++; } }));
	const p = c.get();
	await c.end();
	await p;
	assert.equal(ended, 1);
	const f = createConnector(async () => { throw new Error('x'); });
	f.get().catch(() => {});
	await f.end();
});

// #1101 review (the lead): end() and the connect ran with NO time bound, and #1088 calls end() INSIDE the PHP lock. An
// await that never settles while holding the lock leaves every request queued behind it hanging. Both are bounded now:
// on expiry a named '@event' is logged and the reference dropped, so the lock always releases.
import { withDbRun } from '../db-lifecycle.mjs';
const never = () => new Promise(() => {});
test('RED-then-GREEN: a connection whose end() never settles still lets withDbRun return within the bound', async () => {
	const lines = [];
	const c = createConnector(async () => ({ end: never }), { endMs: 50, log: (o) => lines.push(o) });
	const t0 = Date.now();
	await withDbRun({ reset: () => c.reset(), end: () => c.end() }, async () => { await c.get(); });
	assert.ok(Date.now() - t0 < 1000, 'returned within the bound, not hung');
	assert.equal(lines[0]['@event'], 'db-end-timeout');
	assert.equal(lines[0].after, 'end');
});
test('an in-flight connect that never lands: end() still returns within the bound, and logs it', async () => {
	const lines = [];
	const c = createConnector(never, { endMs: 50, connectMs: 10_000, log: (o) => lines.push(o) });
	c.get().catch(() => {});
	const t0 = Date.now();
	await c.end();
	assert.ok(Date.now() - t0 < 1000);
	assert.equal(lines[0]['@event'], 'db-end-timeout');
	assert.equal(lines[0].after, 'pending-connect');
});
test('a connect that never settles is bounded too: the attempt times out (connect-timeout), is retried once, then the error stands', async () => {
	const lines = [];
	let calls = 0;
	const c = createConnector(() => { calls++; return never(); }, { connectMs: 30, log: (o) => lines.push(o) });
	const t0 = Date.now();
	await assert.rejects(c.get(), /connect timed out/);
	assert.ok(Date.now() - t0 < 1000);
	assert.equal(calls, 2, 'retried once');
	assert.deepEqual(lines.map((o) => o['@event']), ['connect-timeout', 'connect-timeout']);
});
test('the defaults are measured-sized bounds (connect 3 s, end 2 s)', async () => {
	const { CONNECT_MS, END_MS } = await import('../connector.mjs');
	assert.equal(CONNECT_MS, 3000);
	assert.equal(END_MS, 2000);
});

// #1101 rays (strummer, Workers Observability): both hung requests logged their req line (PHP done, response built) and were
// declared hung 4 to 6 ms later. The await left was ctx.waitUntil(dbHandler.end()) on a connection whose socket had died, so
// mysql2's end() waited for a QUIT reply that never comes, with nothing pending. On db-end-timeout the socket is now
// destroyed (mysql2 destroy(): no reply needed), so the dead connection is torn down, not abandoned.
test('#1101: an end() that never settles is bounded AND the connection is destroyed', async () => {
	let destroyed = 0;
	const c = createConnector(async () => ({ end: never, destroy: () => { destroyed++; } }), { endMs: 30 });
	await c.get();
	await c.end();
	assert.equal(destroyed, 1);
});
test('#1101: a normal end() does not destroy', async () => {
	let destroyed = 0;
	const c = createConnector(async () => ({ end: async () => {}, destroy: () => { destroyed++; } }), { endMs: 30 });
	await c.get();
	await c.end();
	assert.equal(destroyed, 0);
});
