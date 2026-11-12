// alarm-arm.mjs (issue #291): a stale alarm no longer blocks the cron for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldArmAlarm, STALE_MS, armBeforeRun } from '../alarm-arm.mjs';
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
