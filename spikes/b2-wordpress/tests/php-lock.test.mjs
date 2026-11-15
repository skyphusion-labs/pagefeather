// php-lock.mjs (#296 step 1.1): the one-at-a-time PHP lock, on a fake clock.
// The defect it fixes (#296 step 0, 2026-11-15, checkout ladder): under concurrency requests queue in
// one isolate; at 60 s of WAITING the old rule booted a second PHP runtime beside the live one, the
// isolate passed its memory limit, and every queued request died (80 exceededMemory, CPU p50 0.22 ms).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhpLock, PHP_SHED, shedMsFor } from '../php-lock.mjs';

// A fake clock: timers run in time order when advanced, with the microtasks between them drained.
function fakeClock() {
	let t = 0;
	let timers = [];
	let seq = 0;
	const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
	return {
		now: () => t,
		setTimer: (fn, ms) => { const id = ++seq; timers.push({ id, at: t + Math.max(0, ms), fn }); return id; },
		clearTimer: (id) => { timers = timers.filter((x) => x.id !== id); },
		async advance(ms) {
			const end = t + ms;
			await flush();
			for (;;) {
				timers.sort((a, b) => a.at - b.at || a.id - b.id);
				const next = timers[0];
				if (!next || next.at > end) break;
				timers.shift();
				t = next.at;
				next.fn();
				await flush();
			}
			t = end;
			await flush();
		},
	};
}

// A PHP run that takes ms on the fake clock, and records how many runs overlap.
function harness(opts = {}) {
	const c = fakeClock();
	const events = [];
	const lock = createPhpLock({ staleMs: 60000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, log: (e) => events.push(e), ...opts });
	let live = 0, maxLive = 0, stales = 0;
	const job = (ms, val) => () => new Promise((res) => { live++; maxLive = Math.max(maxLive, live); c.setTimer(() => { live--; res(val); }, ms); });
	const stuck = () => () => new Promise(() => { live++; maxLive = Math.max(maxLive, live); });
	const run = (fn, o = {}) => lock.run(fn, { onStale: () => stales++, ...o });
	return { c, lock, events, job, stuck, run, get maxLive() { return maxLive; }, get stales() { return stales; } };
}

// The rule before this change (index.js withPhp at 8c14ce7): a waiter that WAITED LOCK_STALE_MS goes on
// with a new runtime, whatever the run ahead is doing. Kept here as the control.
function oldRule(c, staleMs, onStale) {
	let q = Promise.resolve();
	return (fn) => {
		const prev = q;
		const run = (async () => {
			let timer;
			const stale = await Promise.race([prev.then(() => false, () => false), new Promise((ok) => (timer = c.setTimer(() => ok(true), staleMs)))]);
			c.clearTimer(timer);
			if (stale) onStale();
			return fn();
		})();
		q = run.catch(() => {});
		return run;
	};
}

test('runs one at a time, in arrival order, and returns each result', async () => {
	const h = harness();
	const order = [];
	const ps = [1, 2, 3].map((i) => h.run(() => h.job(1000, i)().then((v) => (order.push(v), v))));
	await h.c.advance(5000);
	assert.deepEqual(await Promise.all(ps), [1, 2, 3]);
	assert.deepEqual(order, [1, 2, 3]);
	assert.equal(h.maxLive, 1);
});

test('a deep queue of healthy runs never boots a second runtime (the step 0 defect), while the old rule does', async () => {
	// 8 checkouts of 10 s each, queued at once: the last waits 70 s, past the 60 s stale line.
	const h = harness();
	const ps = Array.from({ length: 8 }, (_, i) => h.run(h.job(10000, i)));
	await h.c.advance(100000);
	assert.deepEqual(await Promise.all(ps), [0, 1, 2, 3, 4, 5, 6, 7]);
	assert.equal(h.stales, 0, 'no stale drop: every run ahead was making progress');
	assert.equal(h.maxLive, 1, 'never two PHP runs at once');
	// Control: the same queue under the old rule goes stale and runs two at once.
	const c = fakeClock();
	let oldStales = 0, live = 0, maxLive = 0;
	const old = oldRule(c, 60000, () => oldStales++);
	const job = (ms) => () => new Promise((res) => { live++; maxLive = Math.max(maxLive, live); c.setTimer(() => { live--; res(); }, ms); });
	const ops = Array.from({ length: 8 }, () => old(job(10000)));
	await c.advance(100000);
	await Promise.all(ops);
	assert.ok(oldStales > 0, 'the control must reproduce the defect, or this test cannot fail');
	assert.ok(maxLive > 1);
});

test('a run that is itself stuck past the stale line still frees the lock (the Free-tier CPU kill)', async () => {
	const h = harness();
	h.run(h.stuck());
	const p = h.run(h.job(1000, 'next'));
	await h.c.advance(59000);
	assert.equal(h.stales, 0);
	await h.c.advance(3000);
	assert.equal(h.stales, 1, 'stale once the RUN AHEAD has run 60 s');
	await h.c.advance(2000);
	assert.equal(await p, 'next');
	assert.ok(h.events.some((e) => e.event === 'stale' && e.headMs >= 60000));
});

test('shed: past the bound a waiter answers PHP_SHED at once, and the order behind it holds', async () => {
	const h = harness();
	const a = h.run(h.job(40000, 'a'), { shedMs: 30000 });
	const b = h.run(h.job(1000, 'b'), { shedMs: 30000 });
	const c = h.run(h.job(1000, 'c'));
	await h.c.advance(30500);
	assert.equal(await b, PHP_SHED, 'b waited 30 s behind a 40 s run');
	assert.equal(h.maxLive, 1);
	await h.c.advance(20000);
	assert.equal(await a, 'a');
	assert.equal(await c, 'c', 'c, behind the shed b, ran after a, never beside it');
	assert.equal(h.maxLive, 1);
	const shed = h.events.find((e) => e.event === 'shed');
	assert.ok(shed && shed.waitMs >= 30000 && shed.waitMs < 31000, JSON.stringify(shed));
	assert.equal(typeof shed.depth, 'number');
	assert.equal(h.stales, 0);
});

test('shed at the grant: a head that never yields to timers still cannot pass a waiter over its bound', async () => {
	// Measured on local workerd (b-do, 40 parallel, PHP_QUEUE_SHED_MS=1000): waits up to 2.7 s were GRANTED.
	// A PHP run that does not yield lets no waiter timer fire, and when it ends the turn (a microtask) beats
	// the overdue timer. Here the lock's own timers never fire at all, so only the grant-time check can shed.
	const c = fakeClock();
	const events = [];
	const lock = createPhpLock({ staleMs: 60000, now: c.now, setTimer: () => 0, clearTimer: () => {}, log: (e) => events.push(e) });
	const job = (ms, v) => () => new Promise((res) => c.setTimer(() => res(v), ms));
	const a = lock.run(job(2000, 'a'), { shedMs: 1000 });
	const b = lock.run(job(10, 'b'), { shedMs: 1000 });
	const d = lock.run(job(10, 'd'), { shedMs: 5000 });
	await c.advance(3000);
	assert.equal(await a, 'a');
	assert.equal(await b, PHP_SHED, 'b waited 2 s against a 1 s bound: shed when its turn came');
	assert.equal(await d, 'd', 'd waited 2 s against a 5 s bound: it runs');
	assert.ok(events.some((e) => e.event === 'shed' && e.at === 'grant'), JSON.stringify(events));
});

test('shedMs 0 never sheds; a waiter that never sheds just waits its turn', async () => {
	const h = harness();
	// b waits 50 s, past any shed bound it could have had, and is granted when a ends.
	const a = h.run(h.job(50000, 'a'));
	const b = h.run(h.job(1000, 'b'), { shedMs: 0 });
	await h.c.advance(55000);
	assert.equal(await a, 'a');
	assert.equal(await b, 'b');
	assert.equal(h.stales, 0, 'a ran 50 s, under the stale line: no second runtime');
});

test('logs: queued with the depth, granted after a wait, and nothing for an uncontended run', async () => {
	const h = harness();
	await Promise.all([h.run(h.job(10, 'solo')), h.c.advance(100)]);
	assert.equal(h.events.length, 0, 'an uncontended run logs nothing');
	const a = h.run(h.job(5000, 'a'));
	const b = h.run(h.job(10, 'b'));
	await h.c.advance(6000);
	await Promise.all([a, b]);
	const q = h.events.find((e) => e.event === 'queued');
	assert.ok(q && q.depth === 1, JSON.stringify(h.events));
	const g = h.events.find((e) => e.event === 'granted');
	assert.ok(g && g.waitMs >= 5000, JSON.stringify(h.events));
	assert.equal(h.lock.waiting, 0);
	assert.equal(h.lock.running, 0);
});

test('a run that throws releases the lock, and the error reaches its caller', async () => {
	const h = harness();
	const a = h.run(() => Promise.reject(new Error('boom')));
	const b = h.run(h.job(10, 'b'));
	await h.c.advance(100);
	await assert.rejects(a, /boom/);
	assert.equal(await b, 'b');
});

test('shedMsFor: the Worker path sheds at 45 s by default, the object path never by default', () => {
	assert.deepEqual(shedMsFor({}, false), { ms: 45000, source: 'default' });
	assert.deepEqual(shedMsFor({}, true), { ms: 0, source: 'default' });
	assert.deepEqual(shedMsFor({ PHP_QUEUE_SHED_MS: '20000' }, true), { ms: 20000, source: 'PHP_QUEUE_SHED_MS' });
	assert.deepEqual(shedMsFor({ PHP_QUEUE_SHED_MS: 'off' }, false), { ms: 0, source: 'PHP_QUEUE_SHED_MS' });
	const bad = shedMsFor({ PHP_QUEUE_SHED_MS: '50' }, false);
	assert.equal(bad.ms, 45000);
	assert.match(bad.refused, /1000 to 120000/);
	assert.equal(shedMsFor({ PHP_QUEUE_SHED_MS: '' }, false).ms, 45000);
});
