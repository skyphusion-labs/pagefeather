// #837: approach A's gateway purge (a-purge.mjs). A purge the account rate limit refuses (code 1134) must never be lost:
// it is kept and retried, repeated whole-tag asks coalesce into one send, and a guest copy is never served past a write
// for longer than the stated limit (purgeWindowMs: PAGE_CACHE_TTL + stale-while-revalidate, 720 s by default).
// Run: node --test spikes/b2-wordpress/tests/a-purge.test.mjs
//
// A virtual clock and a model of the account purge bucket (5 a minute, a bucket of 25, code 1134 when empty; #699).
// The gateway purger is the shipped code. The cron object below is a MODEL of index.js PhpRuntime.requestPurge and its
// alarm, built on the same purge-state.mjs functions: it proves the decision path, not the deployed object.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGatewayPurger, aPurgeRoute, WAITUNTIL_BUDGET_MS, PURGE_OBJECT_NAME } from '../a-purge.mjs';
import { CRON_OBJECT_NAME } from '../a-cron.mjs';
import { PURGE_GAP_MS, RETRY_MS, purgeWindowMs, onAsk, onDue, onResult } from '../purge-state.mjs';

const REFUSED = { ok: false, errors: [{ code: 1134, message: 'Unable to purge, rate limit reached.' }] };
const OK = { ok: true, errors: [] };
const WINDOW = purgeWindowMs({});

const flush = async () => {
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
function world() {
	let t = 1_000_000;
	let seq = 0;
	const q = [];
	const logs = [];
	const w = {
		now: () => t,
		sleep: (ms) => new Promise((r) => q.push({ at: t + Math.max(0, ms), r, seq: seq++ })),
		log: (o) => logs.push({ t, ...o }),
		logs,
		async run(until) {
			for (;;) {
				await flush();
				q.sort((a, b) => a.at - b.at || a.seq - b.seq);
				if (!q.length || q[0].at > until) {
					t = Math.max(t, until);
					await flush();
					return;
				}
				const x = q.shift();
				t = x.at;
				x.r();
			}
		},
	};
	return w;
}
// The account bucket: capacity 25, one token per 12 s. refuseFirst: refuse the next n sends regardless.
function bucket(w, { tokens = 25, refuseFirst = 0 } = {}) {
	let n = tokens;
	let last = w.now();
	const b = {
		sends: [],
		refuseFirst,
		take() {
			const t = w.now();
			n = Math.min(25, n + (t - last) / 12000);
			last = t;
			if (b.refuseFirst > 0) {
				b.refuseFirst--;
				b.sends.push({ t, ok: false });
				return REFUSED;
			}
			if (n >= 1) {
				n -= 1;
				b.sends.push({ t, ok: true });
				return OK;
			}
			b.sends.push({ t, ok: false });
			return REFUSED;
		},
		drain() {
			n = 0;
			last = w.now();
		},
	};
	return b;
}
function ctxFor(w, b, extra = {}) {
	const pend = [];
	return { pend, waitUntil: (p) => pend.push(p), purge: async () => b.take(), ...extra };
}

test('the route: the site purge object when the Worker has PHP_RUNTIME, else this isolate', () => {
	assert.equal(aPurgeRoute({ PHP_RUNTIME: {} }), 'object');
	assert.equal(aPurgeRoute({ A_CRON: 'on', PHP_RUNTIME: {} }), 'object');
	assert.equal(aPurgeRoute({ A_CRON: 'on' }), 'local', 'no PHP_RUNTIME binding: no object');
	assert.equal(aPurgeRoute({}), 'local');
	assert.equal(aPurgeRoute({ PHP_RUNTIME: {}, PHP_IN_DO: 'on' }), 'local', 'b-dosql never routes here');
	assert.notEqual(PURGE_OBJECT_NAME, CRON_OBJECT_NAME, 'never the cron object: a write must not start WP-Cron');
});

// index.js cannot be imported under node (it loads php-wasm), so its wiring is read as text, as rpc-dispose does.
test('index.js wiring: the hand-off asks the purge object purge-only, and its alarm sends purges and nothing else', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /idFromName\(PURGE_OBJECT_NAME\)\)\.requestPurge\(\{ purgeOnly: true \}\)/, 'the gateway hands off to the purge object');
	assert.doesNotMatch(src, /idFromName\(CRON_OBJECT_NAME\)\)\.requestPurge/, 'never to the cron object');
	const alarm = src.indexOf('\tasync alarm() {');
	const only = src.indexOf('if (await this.ctx.storage.get(PURGE_ONLY_KEY)) {', alarm);
	const off = src.indexOf('if (aCronObjectOff(this.env)) {', alarm);
	const arm = src.indexOf('armBeforeRun(this.ctx.storage', alarm);
	assert.ok(alarm > 0 && only > alarm, 'the purge-only branch is in alarm()');
	assert.ok(only < off && only < arm, 'and comes before the cron-off delete and the cron re-arm');
	const branch = src.slice(only, src.indexOf('\n\t\t}\n', only));
	assert.match(branch, /await this\.sendDuePurge\(\);/);
	assert.match(branch, /return;/);
	assert.doesNotMatch(branch, /alarmRun|armBeforeRun|rearm\(/, 'no cron leg and no cron cadence in the purge-only alarm');
	assert.match(src, /async requestPurge\(opts\) \{[\s\S]{0,400}opts\.purgeOnly\) await this\.ctx\.storage\.put\(PURGE_ONLY_KEY, 1\)/, 'requestPurge marks the purge object');
	assert.equal((src.match(/await this\.sendDuePurge\(\);/g) || []).length, 2, 'one purge block, called by the cron alarm and the purge-only alarm');
});

test('local: a 1134 refusal is retried after one bucket refill, inside the same waitUntil, never dropped', async () => {
	const w = world();
	const b = bucket(w, { refuseFirst: 1 });
	let disposed = 0;
	const p = createGatewayPurger({ now: w.now, sleep: w.sleep, log: w.log, env: {}, dispose: () => disposed++ });
	const asked = w.now();
	p.ask(ctxFor(w, b));
	await w.run(asked + 120000);
	assert.deepEqual(b.sends.map((s) => s.ok), [false, true], 'refused, then sent');
	assert.equal(b.sends[1].t - b.sends[0].t, RETRY_MS[0], 'the retry waits one bucket refill (12 s)');
	assert.ok(RETRY_MS[0] <= WAITUNTIL_BUDGET_MS, 'the first retry fits in the waitUntil budget');
	assert.equal(p.state().pending, false);
	assert.equal(disposed, 2, 'each purge result is disposed (#510)');
	// A second refusal's retry (12 + 24 s) is past the budget: the next test covers the purge left pending then.
	assert.ok(RETRY_MS[0] + RETRY_MS[1] > WAITUNTIL_BUDGET_MS);
});

test('local: still refused at the end of the waitUntil budget, the purge stays pending and the next request sends it', async () => {
	const w = world();
	const b = bucket(w, { refuseFirst: 99 });
	const p = createGatewayPurger({ now: w.now, sleep: w.sleep, log: w.log, env: {} });
	p.ask(ctxFor(w, b));
	await w.run(w.now() + 120000);
	const n = b.sends.length;
	assert.ok(n >= 2, 'retried inside the budget');
	assert.ok(b.sends[n - 1].t - b.sends[0].t <= WAITUNTIL_BUDGET_MS, 'no send outside the waitUntil budget');
	assert.equal(p.state().pending, true, 'kept, not dropped');
	assert.ok(w.logs.some((l) => l.m === 'purge-pending'), 'a refused purge left pending is logged');
	b.refuseFirst = 0;
	p.kick(ctxFor(w, b)); // the next request of this isolate
	await w.run(w.now() + 60000);
	assert.equal(b.sends[b.sends.length - 1].ok, true, 'the next request sent it');
	assert.equal(p.state().pending, false);
});

test('local: 50 whole-tag asks in 10 s, with refusals, coalesce into one pending purge that covers the first ask', async () => {
	const w = world();
	const b = bucket(w, { refuseFirst: 1 });
	const p = createGatewayPurger({ now: w.now, sleep: w.sleep, log: w.log, env: {} });
	const first = w.now();
	for (let i = 0; i < 50; i++) {
		p.ask(ctxFor(w, b));
		await w.run(w.now() + 200);
	}
	await w.run(first + 120000);
	assert.ok(b.sends.length <= 3, `at most a send, a retry and one for asks during it (got ${b.sends.length})`);
	const okAt = b.sends.find((s) => s.ok);
	assert.ok(okAt, 'one send succeeded');
	assert.equal(p.state().pending, false, 'every ask is covered');
	assert.equal(w.logs.filter((l) => l.m === 'purge' && l.asked).length, 50, 'each ask is logged once');
});

test('local: a purge refused for longer than the purge window expires, counted, and is not sent after it', async () => {
	const w = world();
	const b = bucket(w, { refuseFirst: 1e9 });
	const p = createGatewayPurger({ now: w.now, sleep: w.sleep, log: w.log, env: {} });
	const asked = w.now();
	p.ask(ctxFor(w, b));
	for (let t = asked; t < asked + WINDOW + 120000; t += 20000) {
		await w.run(t);
		p.kick(ctxFor(w, b));
	}
	await w.run(asked + WINDOW + 180000);
	assert.ok(b.sends.every((s) => s.t - asked <= WINDOW), 'no send after the window');
	assert.ok(w.logs.some((l) => l.m === 'purge-expired'), 'the expiry is logged');
	assert.equal(p.state().pending, false);
	assert.equal(p.state().expired, 1);
});

test('object route: each ask is handed to the site purge object, never purged here', async () => {
	const w = world();
	const b = bucket(w);
	let handed = 0;
	const p = createGatewayPurger({ now: w.now, sleep: w.sleep, log: w.log, env: { PHP_RUNTIME: {} } });
	for (let i = 0; i < 3; i++) p.ask(ctxFor(w, b, { handOff: async () => (handed++, 'scheduled') }));
	await w.run(w.now() + 60000);
	assert.equal(handed, 3);
	assert.equal(b.sends.length, 0, 'the gateway sent no purge itself');
	assert.equal(w.logs.filter((l) => l.m === 'purge').length, 0, 'no m: purge line from the gateway: the object logs the ask (#688 guard)');
});

test('object route: a hand-off that fails falls back to this isolate, so the purge is still sent', async () => {
	const w = world();
	const b = bucket(w);
	const p = createGatewayPurger({ now: w.now, sleep: w.sleep, log: w.log, env: { PHP_RUNTIME: {} } });
	p.ask(ctxFor(w, b, { handOff: async () => { throw new Error('object unreachable'); } }));
	await w.run(w.now() + 60000);
	assert.equal(b.sends.length, 1);
	assert.equal(b.sends[0].ok, true);
	assert.ok(w.logs.some((l) => l.m === 'purge-handoff' && l.ok === false), 'the failed hand-off is logged');
	assert.equal(w.logs.filter((l) => l.m === 'purge' && l.asked).length, 1, 'the ask is logged once, by the fallback');
});

// The stated limit, end to end on the object route: writes for 30 min on a site whose neighbour keeps spending the
// account bucket. For every write, the first successful purge after it comes before the write's age reaches
// purgeWindowMs (or the purge expired exactly because every copy it targets has aged out). The cron object is the
// MODEL of index.js requestPurge + the purge object's alarm (sendDuePurge) (purge-state.mjs, fail-open: no budget binding).
function modelCronObject(w, b) {
	let st = {};
	let alarm = null;
	const o = {
		sends: [],
		expired: 0,
		arm(at) {
			if (alarm != null && alarm <= at) return;
			alarm = at;
			w.sleep(at - w.now()).then(() => {
				if (alarm !== at) return;
				alarm = null;
				o.fire();
			});
		},
		async requestPurge() {
			const a = onAsk(st, w.now());
			st = a.st;
			if (a.alarmAt != null) o.arm(a.alarmAt);
			return a.coalesced ? 'coalesced' : 'scheduled';
		},
		fire() {
			const d = onDue(st, w.now(), WINDOW);
			st = d.st;
			if (d.action === 'expire') o.expired++;
			if (d.action !== 'send') return;
			const r = b.take();
			o.sends.push({ t: w.now(), ok: r.ok, covers: d.covered.firstAsked });
			const res = onResult(st, w.now(), r, d.covered);
			st = res.st;
			if (res.alarmAt != null) o.arm(res.alarmAt);
			else if (st.pending) o.arm(Math.max(w.now(), st.lastSent + PURGE_GAP_MS));
		},
	};
	return o;
}

test('the stated limit: under a neighbour draining the bucket, no write waits longer than purgeWindowMs for its purge', async () => {
	const w = world();
	const b = bucket(w);
	const obj = modelCronObject(w, b);
	const p = createGatewayPurger({ now: w.now, sleep: w.sleep, log: w.log, env: { PHP_RUNTIME: {} } });
	const writes = [];
	const t0 = w.now();
	let rnd = 7;
	const next = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
	for (let t = t0; t < t0 + 30 * 60000; t += 1000 + Math.floor(next() * 17000)) {
		await w.run(t);
		if (next() < 0.35) b.drain(); // the neighbour spends the whole account bucket
		writes.push(w.now());
		p.ask(ctxFor(w, b, { handOff: () => obj.requestPurge() }));
	}
	await w.run(t0 + 30 * 60000 + WINDOW + 60000);
	assert.ok(b.sends.some((s) => !s.ok), 'the run did see 1134 refusals (else it tests nothing)');
	let worst = 0;
	for (const wt of writes) {
		const s = obj.sends.find((x) => x.ok && x.t >= wt);
		const lag = s ? s.t - wt : Infinity;
		worst = Math.max(worst, lag === Infinity ? WINDOW : lag);
		assert.ok(lag <= WINDOW, `write at +${(wt - t0) / 1000}s waited ${lag / 1000}s for a successful purge`);
	}
	console.log(JSON.stringify({ writes: writes.length, sends: obj.sends.length, refused: obj.sends.filter((s) => !s.ok).length, worstLagS: worst / 1000, expired: obj.expired }));
});
