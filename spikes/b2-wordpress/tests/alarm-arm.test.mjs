// alarm-arm.mjs (issue #291): a stale alarm no longer blocks the cron for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldArmAlarm, STALE_MS, armBeforeRun, rearm, recordAlarmFatal, ALARM_FATAL_KEY } from '../alarm-arm.mjs';
import { readFileSync } from 'node:fs';

const now = Date.parse('2026-11-11T21:15:00Z');

test('no alarm: arm (the existing rule)', () => {
	assert.equal(shouldArmAlarm(null, now), true);
	assert.equal(shouldArmAlarm(undefined, now), true);
});

test('an alarm in the future: leave it', () => {
	assert.equal(shouldArmAlarm(now + 60_000, now), false);
});

test('a due alarm, just past: leave it (it is about to run)', () => {
	assert.equal(shouldArmAlarm(now - 30_000, now), false);
	assert.equal(shouldArmAlarm(now - STALE_MS + 1, now), false);
});

test('THE GGC.SH CASE: an alarm two hours in the past is stale, so arm again', () => {
	assert.equal(shouldArmAlarm(Date.parse('2026-11-11T19:14:26Z'), now), true);
});

test('CONTROL: the old rule ("only when none") would never arm in the ggc.sh case', () => {
	const oldRule = (at) => at === null || at === undefined;
	assert.equal(oldRule(Date.parse('2026-11-11T19:14:26Z')), false);
});

// armBeforeRun (issue #291, 2026-11-12): the next tick is set and flushed BEFORE the run.
test('armBeforeRun sets now + interval and flushes it, in that order', async () => {
	const calls = [];
	const storage = { setAlarm: async (t) => calls.push(['setAlarm', t]), sync: async () => calls.push(['sync']) };
	const at = await armBeforeRun(storage, now, 60_000);
	assert.equal(at, now + 60_000);
	assert.deepEqual(calls, [['setAlarm', now + 60_000], ['sync']]);
});

test('armBeforeRun works on a storage without sync()', async () => {
	const calls = [];
	await armBeforeRun({ setAlarm: async (t) => calls.push(t) }, now, 1000);
	assert.deepEqual(calls, [now + 1000]);
});

test('alarm() calls armBeforeRun before it boots PHP or runs the cron (index.js source order)', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const a = src.indexOf('async alarm() {');
	assert.ok(a >= 0, 'alarm() found');
	const body = src.slice(a, src.indexOf('async fetch(raw)', a));
	const arm = body.indexOf('await armBeforeRun(this.ctx.storage');
	assert.ok(arm >= 0, 'alarm() calls armBeforeRun');
	assert.ok(arm < body.indexOf('runCron('), 'armBeforeRun comes before runCron');
	assert.ok(arm < body.indexOf('boot(cronOrigin)'), 'armBeforeRun comes before the PHP boot');
	assert.ok(arm < body.indexOf('try {'), 'armBeforeRun is outside (before) the try');
});

// rearm (issue #291): a stale alarm is deleted, then set; others are left alone.
const fakeStorage = (at) => {
	const calls = [];
	return { calls, getAlarm: async () => at, deleteAlarm: async () => calls.push(['deleteAlarm']), setAlarm: async (t) => calls.push(['setAlarm', t]) };
};
test('rearm: no alarm -> set only', async () => {
	const s = fakeStorage(null);
	assert.deepEqual(await rearm(s, now, 60_000), { armed: true, stale: false, was: null });
	assert.deepEqual(s.calls, [['setAlarm', now + 60_000]]);
});
test('rearm: THE STUCK CASE, a stale alarm -> deleteAlarm THEN setAlarm', async () => {
	const was = Date.parse('2026-11-11T19:14:26Z');
	const s = fakeStorage(was);
	assert.deepEqual(await rearm(s, now, 60_000), { armed: true, stale: true, was });
	assert.deepEqual(s.calls, [['deleteAlarm'], ['setAlarm', now + 60_000]]);
});
test('rearm: a future or just-due alarm is untouched', async () => {
	for (const at of [now + 60_000, now - 30_000]) {
		const s = fakeStorage(at);
		assert.deepEqual(await rearm(s, now, 60_000), { armed: false });
		assert.deepEqual(s.calls, []);
	}
});
test('index.js: both re-arm sites go through rearm (no bare setAlarm over a stale alarm)', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.equal((src.match(/await rearm\(this\.ctx\.storage/g) || []).length, 2);
	assert.equal(/shouldArmAlarm\(await this\.ctx\.storage\.getAlarm\(\)/.test(src), false);
});

// alarm() never lets an error out (issue #291, fdprobe1112c 2026-11-12).
test('recordAlarmFatal stores time, message, stack and a running count', async () => {
	const m = new Map();
	const storage = { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) };
	const r1 = await recordAlarmFatal(storage, new Error('boom'), now);
	assert.equal(r1.error, 'boom'); assert.equal(r1.t, now); assert.equal(r1.count, 1); assert.match(r1.stack, /boom/);
	const r2 = await recordAlarmFatal(storage, 'plain string', now + 1);
	assert.equal(r2.error, 'plain string'); assert.equal(r2.count, 2);
	assert.deepEqual(m.get(ALARM_FATAL_KEY), r2);
});
test('index.js: alarm() arms first, then runs alarmRun inside a catch that does not rethrow', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const a = src.indexOf('async alarm() {');
	const r = src.indexOf('async alarmRun() {', a);
	assert.ok(a >= 0 && r > a, 'alarm() and alarmRun() exist');
	const wrapper = src.slice(a, r);
	assert.ok(wrapper.indexOf('await armBeforeRun(') < wrapper.indexOf('await this.alarmRun()'), 'arms before the run');
	assert.ok(/catch \(e\) \{[\s\S]*recordAlarmFatal\(this\.ctx\.storage, e/.test(wrapper), 'the catch records the error');
	assert.equal(/\bthrow\b/.test(wrapper.replace(/\/\/.*$/gm, '')), false, 'the wrapper never throws');
	assert.ok(src.slice(r, src.indexOf('async fetch(raw)', r)).indexOf('armBeforeRun(') < 0, 'alarmRun does not re-arm first again');
});
