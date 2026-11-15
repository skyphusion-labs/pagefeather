// overflow.mjs (#296 step (3), ruled 2026-11-15): a request that would WAIT in a busy Worker isolate
// runs on a pool Durable Object instead, before it has run. Pure decisions, plus a two-isolate
// simulation on the REAL php-lock.mjs and a fake clock: never two runs at once in one isolate or object,
// and every request runs exactly once, wherever it runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overflowSettings, shouldOverflow, createPicker, overflowName } from '../overflow.mjs';
import { createPhpLock } from '../php-lock.mjs';

test('settings: off by default; on, always, the depth, the pool and the hint', () => {
	assert.deepEqual(overflowSettings({}), { on: false, always: false, depth: 1, pool: 8, hint: 'wnam' });
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on' }).on, true);
	const a = overflowSettings({ PHP_OVERFLOW: 'always', PHP_OVERFLOW_DEPTH: '0', PHP_OVERFLOW_POOL: '32', PHP_OVERFLOW_HINT: 'enam' });
	assert.deepEqual(a, { on: true, always: true, depth: 0, pool: 32, hint: 'enam' });
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'yes' }).on, false, 'only on or always turn it on');
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_POOL: '0' }).pool, 8, 'a bad pool keeps the default');
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_POOL: '999' }).pool, 8);
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_DEPTH: 'x' }).depth, 1);
	assert.equal(overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_HINT: 'mars' }).hint, 'wnam', 'only a real location hint');
});

test('the decision: only when this isolate is busy and the queue is at the depth; never a spike path or an upload', () => {
	const on = overflowSettings({ PHP_OVERFLOW: 'on' });
	const u = (p) => new URL('https://s.example' + p);
	assert.equal(shouldOverflow(on, { running: 0, waiting: 0 }, u('/'), false), false, 'idle: run here');
	assert.equal(shouldOverflow(on, { running: 1, waiting: 0 }, u('/'), false), false, 'one in flight, none waiting: depth 1 not reached');
	assert.equal(shouldOverflow(on, { running: 1, waiting: 1 }, u('/'), false), true, 'busy and one waiting: overflow');
	assert.equal(shouldOverflow(on, { running: 1, waiting: 5 }, u('/_install'), false), false, 'spike and operator paths stay here');
	assert.equal(shouldOverflow(on, { running: 1, waiting: 5 }, u('/wp-admin/async-upload.php'), true), false, 'a media upload stays here');
	assert.equal(shouldOverflow(overflowSettings({}), { running: 1, waiting: 9 }, u('/'), false), false, 'off: never');
	const d0 = overflowSettings({ PHP_OVERFLOW: 'on', PHP_OVERFLOW_DEPTH: '0' });
	assert.equal(shouldOverflow(d0, { running: 1, waiting: 0 }, u('/'), false), true, 'depth 0: any run in flight');
	assert.equal(shouldOverflow(d0, { running: 0, waiting: 0 }, u('/'), false), false, 'depth 0 but idle: run here, never move a request that would not wait');
	const al = overflowSettings({ PHP_OVERFLOW: 'always' });
	assert.equal(shouldOverflow(al, { running: 0, waiting: 0 }, u('/'), false), true, 'always: even an idle isolate (the functional proof)');
	assert.equal(shouldOverflow(al, { running: 0, waiting: 0 }, u('/_ping'), false), false);
});

test('the picker: power of two choices on in-flight counts, names ovf-<i>, and counts that never go negative', () => {
	assert.equal(overflowName(3), 'ovf-3');
	// rand 0.1 -> first choice i = floor(0.1 * 8) = 0; rand 0.6 -> j = floor(0.6 * 7) = 4, which skips i
	// (j >= i) to 5. So the two choices are objects 0 and 5.
	const seq = [0.1, 0.6];
	let k = 0;
	const p = createPicker(8, () => seq[k++ % seq.length]);
	p.start(0); p.start(0);
	assert.equal(p.pick(), 5, 'object 0 holds 2 in flight, object 5 none: the less loaded wins');
	p.start(5); p.start(5); p.start(5);
	assert.equal(p.pick(), 0, 'now 0 holds 2 and 5 holds 3: object 0 wins');
	assert.deepEqual([p.inflight(0), p.inflight(5)], [2, 3]);
	for (let i = 0; i < 5; i++) p.end(5);
	assert.equal(p.inflight(5), 0, 'never below 0');
	const one = createPicker(1, Math.random);
	for (let i = 0; i < 5; i++) assert.equal(one.pick(), 0);
	// Spread: with real randomness and every pick held, no object gets far more than its share.
	const s = createPicker(8, Math.random);
	for (let i = 0; i < 64; i++) s.start(s.pick());
	const counts = Array.from({ length: 8 }, (_, i) => s.inflight(i));
	assert.ok(Math.max(...counts) <= 12, 'power of two choices keeps the max near the mean (8): ' + counts.join(','));
});

// A fake clock for the simulation (as tests/php-lock.test.mjs).
function fakeClock() {
	let t = 0, timers = [], seq = 0;
	const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
	return {
		now: () => t,
		setTimer: (fn, ms) => { const id = ++seq; timers.push({ id, at: t + Math.max(0, ms), fn }); return id; },
		clearTimer: (id) => { timers = timers.filter((x) => x.id !== id); },
		async advance(ms) {
			const end = t + ms; await flush();
			for (;;) { timers.sort((a, b) => a.at - b.at || a.id - b.id); const n = timers[0]; if (!n || n.at > end) break; timers.shift(); t = n.at; n.fn(); await flush(); }
			t = end; await flush();
		},
	};
}

async function simulate({ env, requests, runMs }) {
	const c = fakeClock();
	const mk = () => createPhpLock({ staleMs: 60000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
	const isolates = [mk(), mk()]; // two Worker isolates, as the platform routes them
	const s = overflowSettings(env);
	const objects = Array.from({ length: s.pool }, mk);
	const picker = createPicker(s.pool, Math.random);
	const ran = new Map(); // request id -> where it ran, how many times
	const live = new Map(); let maxLive = 0;
	const job = (id, where) => () => new Promise((res) => {
		const n = (live.get(where) || 0) + 1; live.set(where, n); maxLive = Math.max(maxLive, n);
		const r = ran.get(id) || { n: 0, where: [] }; r.n++; r.where.push(where); ran.set(id, r);
		c.setTimer(() => { live.set(where, live.get(where) - 1); res(id); }, runMs);
	});
	const ps = [];
	for (let id = 0; id < requests; id++) {
		const iso = isolates[id % 2];
		const where = 'iso' + (id % 2);
		if (shouldOverflow(s, { running: iso.running, waiting: iso.waiting }, new URL('https://s.example/'), false)) {
			const o = picker.pick(); picker.start(o);
			ps.push(objects[o].run(job(id, 'obj' + o)).finally(() => picker.end(o)));
		} else ps.push(iso.run(job(id, where)));
	}
	await c.advance(requests * runMs + 10000);
	await Promise.all(ps);
	return { ran, maxLive, moved: [...ran.values()].filter((r) => r.where[0].startsWith('obj')).length };
}

test('two isolates, 40 requests at once: every request runs exactly once, never two at once anywhere', async () => {
	const r = await simulate({ env: { PHP_OVERFLOW: 'on', PHP_OVERFLOW_POOL: '8' }, requests: 40, runMs: 600 });
	assert.equal(r.ran.size, 40);
	assert.ok([...r.ran.values()].every((x) => x.n === 1), 'each request ran once');
	assert.equal(r.maxLive, 1, 'one run at a time per isolate and per object');
	assert.ok(r.moved > 0 && r.moved < 40, 'some moved (the busy queue), some ran in the isolates: ' + r.moved);
});

test('control: overflow off keeps all 40 in the two isolates (and they still run one at a time)', async () => {
	const r = await simulate({ env: {}, requests: 40, runMs: 600 });
	assert.equal(r.moved, 0);
	assert.ok([...r.ran.values()].every((x) => x.n === 1));
	assert.equal(r.maxLive, 1);
});
