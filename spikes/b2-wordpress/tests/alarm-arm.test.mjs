// alarm-arm.mjs (issue #291): a stale alarm no longer blocks the cron for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldArmAlarm, STALE_MS } from '../alarm-arm.mjs';

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
