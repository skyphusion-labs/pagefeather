import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tickAlarmPlan } from '../alarm-arm.mjs';

// #1164 lever: on approach A every Cron Trigger tick pulled an idle-backed-off (#390) alarm back to one interval, so an
// idle store's cron alarm ran every minute (about 43,800 a month) and the backoff never grew. The tick now pulls only when
// work is due: it reads the same cheap due state the alarm's idle gate reads (two SQL reads, no PHP).
const now = 1_000_000_000_000, iv = 60_000;
test('#1164 an alarm already within one interval is kept, whatever the state', () => {
	assert.deepEqual(tickAlarmPlan({ alarmAt: now + 30_000, now, intervalMs: iv, idleStreak: 3, due: { idle: false } }), { action: 'keep' });
	assert.deepEqual(tickAlarmPlan({ alarmAt: null, now, intervalMs: iv, idleStreak: 0, due: null }), { action: 'keep' }, 'a missing alarm is snapshotRearm work');
});
test('#1164 a far alarm the idle gate did NOT set is pulled in, as before', () => {
	assert.deepEqual(tickAlarmPlan({ alarmAt: now + 240_000, now, intervalMs: iv, idleStreak: 0, due: null }), { action: 'pull' });
});
test('#1164 an idle-backed-off alarm with nothing due is KEPT (the lever)', () => {
	assert.deepEqual(tickAlarmPlan({ alarmAt: now + 240_000, now, intervalMs: iv, idleStreak: 2, due: { idle: true, alarmAt: now + 300_000 } }), { action: 'keep' });
});
test('#1164 work due now (an order email queued by a request) pulls it in', () => {
	assert.deepEqual(tickAlarmPlan({ alarmAt: now + 240_000, now, intervalMs: iv, idleStreak: 2, due: { idle: false } }), { action: 'pull' });
});
test('#1164 work due before the backed-off alarm moves it earlier, never sooner than one interval', () => {
	assert.deepEqual(tickAlarmPlan({ alarmAt: now + 240_000, now, intervalMs: iv, idleStreak: 2, due: { idle: true, alarmAt: now + 150_000 } }), { action: 'earlier', at: now + 150_000 });
	assert.deepEqual(tickAlarmPlan({ alarmAt: now + 240_000, now, intervalMs: iv, idleStreak: 2, due: { idle: true, alarmAt: now + 10_000 } }), { action: 'earlier', at: now + iv });
});
test('#1164 an unreadable due state pulls (the safe side: a missed email costs more than one leg)', () => {
	assert.deepEqual(tickAlarmPlan({ alarmAt: now + 240_000, now, intervalMs: iv, idleStreak: 2, due: null }), { action: 'pull' });
});
test('#1164 index.js: the tick plans with the due state, and reads it only for an idle-backed-off far alarm', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /const plan = tickAlarmPlan\(\{ alarmAt: tickAlarm, now: tickNow, intervalMs: tickIv, idleStreak, due \}\);/);
	assert.match(src, /const due = idleStreak > 0 && tickAlarm !== null && tickAlarm !== undefined && Number\(tickAlarm\) > tickNow \+ tickIv \? await this\.cronIdle\(tickNow\)\.catch\(\(\) => null\) : null;/);
	assert.doesNotMatch(src, /const pulled = await pullIn\(this\.ctx\.storage, Date\.now\(\), Number\(env\.CRON_INTERVAL_MS \|\| 60000\), 'a-cron-tick'\);/, 'the unconditional pull is gone');
});
