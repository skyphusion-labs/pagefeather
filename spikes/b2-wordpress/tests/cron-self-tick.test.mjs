// node --test spikes/b2-wordpress/tests/cron-self-tick.test.mjs (#1310, route (b); design: #1310 issuecomment-7080378918).
// Under Workers for Platforms a Cron Trigger never fires (strummer, #1310: scheduled() never ran in 7 min), while a
// Durable Object alarm does. The approach A cron object already runs its legs on its own alarm; the tick only gave the
// FIRST arm and pulled a backed-off idle alarm in when work appeared. CRON_SELF_TICK=on (rendered by deploy/wfp for a
// kind a site) replaces both: each Worker isolate sends one tick on its first request, and the idle back-off is
// capped at one interval. A deploy.sh site does not set it and behaves exactly as before (#1166).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cronSelfTickOn } from '../a-cron.mjs';
import { idleDecision, IDLE_MAX_MS } from '../cron-idle.mjs';

const A = { PHP_IN_DO: undefined, DB_IN_DO: undefined, A_CRON: 'on', PHP_RUNTIME: {} };

test('cronSelfTickOn: only CRON_SELF_TICK "on", and only where the approach A cron object runs', () => {
	assert.equal(cronSelfTickOn({ ...A, CRON_SELF_TICK: 'on' }), true);
	for (const v of [undefined, '', 'off', 'ON', '1', 'true', ' on']) assert.equal(cronSelfTickOn({ ...A, CRON_SELF_TICK: v }), false, String(v));
	assert.equal(cronSelfTickOn({ ...A, A_CRON: 'off', CRON_SELF_TICK: 'on' }), false, 'A_CRON off: no cron object, no kick');
	assert.equal(cronSelfTickOn({ ...A, A_CRON: undefined, CRON_SELF_TICK: 'on' }), false, 'the rendered A_CRON is what runs it (#1166)');
	assert.equal(cronSelfTickOn({ PHP_IN_DO: 'on', DB_IN_DO: 'on', A_CRON: 'on', CRON_SELF_TICK: 'on' }), false, 'b-dosql runs its own alarm; not this');
	assert.equal(cronSelfTickOn(undefined), false);
});

const base = { now: 1_000_000, intervalMs: 60_000, wp: { due: false, next: null }, as: { known: true, next: null } };

test('selfTick caps the IDLE back-off at one interval: the alarm wakes each interval to run the idle gate', () => {
	for (const streak of [0, 1, 3, 9]) {
		const plain = idleDecision({ ...base, streak });
		const self = idleDecision({ ...base, streak, selfTick: true });
		assert.equal(self.idle, true);
		assert.equal(self.alarmAt, base.now + base.intervalMs, `streak ${streak}: one interval`);
		assert.ok(plain.alarmAt >= self.alarmAt, 'never later than without the cap');
	}
	assert.equal(idleDecision({ ...base, streak: 9 }).alarmAt, base.now + IDLE_MAX_MS, 'the control: without the cap it backs off to 5 min');
});

test('selfTick changes nothing else: due work, unknown state and an email rush are not idle either way', () => {
	for (const extra of [{ wp: { due: true, next: null } }, { as: { known: false, next: null } }, { emailRush: true }, { as: { known: true, next: base.now - 1 } }]) {
		assert.deepEqual(idleDecision({ ...base, ...extra, selfTick: true }), idleDecision({ ...base, ...extra }));
	}
	const sooner = { ...base, wp: { due: false, next: (base.now + 30_000) / 1000 } };
	assert.deepEqual(idleDecision({ ...sooner, selfTick: true }), idleDecision(sooner), 'a due event sooner than the cap: the same floor of one interval');
});

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('index.js: the idle gate passes selfTick from cronSelfTickOn (the input of the cap, not only the cap)', () => {
	assert.match(src, /idleDecision\(\{[^}]*selfTick: cronSelfTickOn\(env\)/);
});

test('index.js: the Worker kicks the cron object once per isolate, through the same tick as scheduled()', () => {
	const at = src.indexOf('// #1310 self-tick kick');
	assert.ok(at > 0, 'the kick is in the Worker fetch');
	const block = src.slice(at, at + 700);
	assert.match(block, /cronSelfTickOn\(env\)/);
	assert.match(block, /!selfTickKicked/);
	assert.match(block, /selfTickKicked = true/);
	assert.match(block, /approachACronScheduled\(/, 'the same tick, the same handler');
	assert.ok(block.indexOf('selfTickKicked = true') < block.indexOf('approachACronScheduled('), 'the flag is set before the send: one per isolate even if the send throws');
	assert.match(src, /^let selfTickKicked = false;/m, 'a module-scope flag: per isolate');
});

test('index.js: the death back-off (#471) is not given the cap', () => {
	assert.doesNotMatch(src, /cronBackoff\([^)]*selfTick/);
});
