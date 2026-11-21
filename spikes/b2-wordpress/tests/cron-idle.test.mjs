// node --test spikes/b2-wordpress/tests/cron-idle.test.mjs (#390, corrected 2026-11-20). An idle site's 60 s alarm
// cold-booted PHP on about 9 of 12 ticks (about 1.9 s CPU each) to find nothing due. The idle gate decides from the
// site's own state, BEFORE any PHP boot: WP-Cron's next event (the cron option), and Action Scheduler's next pending
// action. Nothing due: no boot, and the alarm backs off (2x per idle tick, at most 5 min, never past the next due).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { phpUnserialize, wpCronState, idleDecision, IDLE_MAX_MS, AS_RUNNER_HOOK, parseGmt } from '../cron-idle.mjs';

const ser = (o) => {
	// a tiny PHP serializer for the fixtures (ints, strings, arrays)
	if (typeof o === 'number') return `i:${o};`;
	if (typeof o === 'string') return `s:${Buffer.byteLength(o)}:"${o}";`;
	if (Array.isArray(o)) return `a:${o.length}:{${o.map((v, i) => `i:${i};${ser(v)}`).join('')}}`;
	const ks = Object.keys(o);
	return `a:${ks.length}:{${ks.map((k) => (/^\d+$/.test(k) ? `i:${k};` : ser(k)) + ser(o[k])).join('')}}`;
};
const ev = (schedule) => ({ deadbeef: { schedule, args: [], interval: 60 } });

test('phpUnserialize reads what WordPress stores (arrays, ints, strings, booleans, null, floats, nested)', () => {
	assert.deepEqual(phpUnserialize('a:2:{i:0;s:3:"abc";s:1:"k";a:1:{i:5;b:1;}}'), { 0: 'abc', k: { 5: true } });
	assert.equal(phpUnserialize('N;'), null);
	assert.equal(phpUnserialize('d:1.5;'), 1.5);
	assert.equal(phpUnserialize('s:3:"é!";'), 'é!', 'string lengths are BYTES (é is 2)');
	assert.equal(phpUnserialize('s:2:"é!";'), undefined, 'a character count is not a byte count');
	assert.equal(phpUnserialize('not serialized'), undefined);
	assert.equal(phpUnserialize('a:1:{i:0;s:9:"short";}'), undefined, 'a wrong length is refused, never guessed');
});

test('wpCronState: the earliest event, ignoring the Action Scheduler runner hook (the leg runs Action Scheduler itself)', () => {
	const now = 1000000;
	const cron = ser({ [now - 10]: { [AS_RUNNER_HOOK]: ev('every_minute') }, [now + 600]: { wp_version_check: ev('twicedaily') }, version: 2 });
	assert.deepEqual(wpCronState(cron, now), { due: false, next: now + 600 });
	const due = ser({ [now - 5]: { publish_future_post: ev(false) }, [now + 600]: { wp_version_check: ev('twicedaily') }, version: 2 });
	assert.deepEqual(wpCronState(due, now), { due: true, next: now - 5 });
	assert.deepEqual(wpCronState(ser({ version: 2 }), now), { due: false, next: null });
	assert.equal(wpCronState('garbage', now), null, 'unreadable: the caller runs the leg');
	assert.equal(wpCronState(null, now), null);
});

test('parseGmt reads Action Scheduler scheduled_date_gmt as UTC', () => {
	assert.equal(parseGmt('2026-11-20 12:00:00'), Date.UTC(2026, 10, 20, 12, 0, 0));
	assert.equal(parseGmt(''), null);
	assert.equal(parseGmt(null), null);
	assert.equal(parseGmt('0000-00-00 00:00:00'), null);
});

test('idleDecision: anything due, unknown, or an email rush runs the leg; nothing due skips it and backs off', () => {
	const now = 10_000_000; const interval = 60_000;
	const run = (x) => idleDecision({ now, intervalMs: interval, streak: 0, emailRush: false, ...x });
	assert.equal(run({ wp: { due: true, next: now / 1000 - 1 }, as: { known: true, next: null } }).idle, false, 'WP-Cron due');
	assert.equal(run({ wp: { due: false, next: null }, as: { known: true, next: now - 1 } }).idle, false, 'an Action Scheduler action due');
	assert.equal(run({ wp: null, as: { known: true, next: null } }).idle, false, 'WP-Cron unknown');
	assert.equal(run({ wp: { due: false, next: null }, as: { known: false } }).idle, false, 'Action Scheduler unknown');
	assert.equal(run({ wp: { due: false, next: null }, as: { known: true, next: null }, emailRush: true }).idle, false, 'an email rush');
	const idle = run({ wp: { due: false, next: null }, as: { known: true, next: null } });
	assert.equal(idle.idle, true);
	assert.equal(idle.alarmAt, now + 2 * interval, 'the first idle tick doubles the interval');
});

test('the idle back-off doubles per idle tick, caps at 5 minutes, and never passes the next due event', () => {
	const now = 10_000_000; const interval = 60_000;
	const at = (streak, wpNext = null, asNext = null) => idleDecision({ now, intervalMs: interval, streak, emailRush: false, wp: { due: false, next: wpNext }, as: { known: true, next: asNext } }).alarmAt;
	assert.equal(at(0), now + 120_000);
	assert.equal(at(1), now + 240_000);
	assert.equal(at(2), now + IDLE_MAX_MS);
	assert.equal(at(9), now + IDLE_MAX_MS);
	assert.equal(IDLE_MAX_MS, 5 * 60_000);
	assert.equal(at(5, (now + 90_000) / 1000), now + 90_000, 'a WP-Cron event 90 s ahead: the alarm is at it');
	assert.equal(at(5, null, now + 70_000), now + 70_000, 'an Action Scheduler action 70 s ahead: the alarm is at it');
	assert.equal(at(5, (now + 10_000) / 1000), now + interval, 'never sooner than the normal interval');
});

test('index.js: the gate runs before any PHP boot, a request pulls a backed-off alarm back in, CRON_IDLE_GATE=off is the opt-out', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const run = src.slice(src.indexOf('async alarmRun() {'), src.indexOf('if (cronGo) {'));
	assert.match(run, /const idle = legDue && !emailRush && this\.env\.CRON_IDLE_GATE !== 'off' \? await this\.cronIdle\(/, 'decided before cronGo');
	assert.match(run, /m: 'cron', skipped: 'idle'/);
	assert.match(src, /const ra = await rearm\(this\.ctx\.storage[^\n]*\n[\s\S]{0,400}await pullIn\(this\.ctx\.storage, Date\.now\(\), Number\(\(ENV && ENV\.CRON_INTERVAL_MS\) \|\| 60000\)\)/, 'a request pulls a backed-off alarm back in');
});

import { extendIfOurs } from '../alarm-arm.mjs';
// The lead's review on #1059: the DO has ONE alarm and five setters. The idle back-off must never move a sooner alarm
// later. It extends only the tick this alarm armed itself; any other setter's time (a purge retry, a purge-budget
// wait, deferred mail, a request) is kept, even one set while the idle gate was reading the database.
function alarmStore(at) {
	let cur = at;
	const sets = [];
	return { sets, get cur() { return cur; }, async getAlarm() { return cur; }, async setAlarm(t) { cur = t; sets.push(t); }, async put() {}, async get() {} };
}
test('#1059 review: the back-off extends the alarm when it is still the tick this alarm armed', async () => {
	const s = alarmStore(1000 + 60000);
	assert.equal(await extendIfOurs(s, 1000 + 60000, 1000 + 120000, 1000, 'idle'), true);
	assert.equal(s.cur, 1000 + 120000);
});
test('#1059 review: a PURGE RETRY set while the gate read the database keeps its sooner time', async () => {
	const tick = 1000 + 60000;
	const s = alarmStore(tick);
	await s.setAlarm(1000 + 12000); // purge-retry: 12 s
	assert.equal(await extendIfOurs(s, tick, 1000 + 120000, 1000, 'idle'), false);
	assert.equal(s.cur, 1000 + 12000, 'the purge retry still fires at 12 s');
});
test('#1059 review: a PURGE-BUDGET wait keeps its time, sooner or later than the tick', async () => {
	const tick = 1000 + 60000;
	for (const budgetAt of [1000 + 30000, 1000 + 90000]) {
		const s = alarmStore(tick);
		await s.setAlarm(budgetAt);
		assert.equal(await extendIfOurs(s, tick, 1000 + 300000, 1000, 'idle'), false);
		assert.equal(s.cur, budgetAt, 'the budget wait is never moved by the back-off');
	}
});
test('#1059 review: no alarm at all (deleted meanwhile) is armed at the back-off time; a back-off never moves an alarm SOONER', async () => {
	const s = alarmStore(null);
	assert.equal(await extendIfOurs(s, 1000 + 60000, 1000 + 120000, 1000, 'idle'), true);
	assert.equal(s.cur, 1000 + 120000);
	const t = alarmStore(1000 + 60000);
	assert.equal(await extendIfOurs(t, 1000 + 60000, 1000 + 30000, 1000, 'idle'), false, 'not sooner: the tick stands');
	assert.equal(t.cur, 1000 + 60000);
});
test('#1059 review: index.js extends only its own tick, from alarm() to the idle path', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /this\.tickAt = await armBeforeRun\(this\.ctx\.storage/);
	assert.match(src, /await extendIfOurs\(this\.ctx\.storage, this\.tickAt, idle\.alarmAt, Date\.now\(\), 'idle'\)/);
	assert.ok(!/await setAlarmRecorded\(this\.ctx\.storage, idle\.alarmAt/.test(src), 'no unconditional set');
});

// #1059, after #1062 merged (agreed on #1059): the idle back-off must not pass the next MAIL RETRY. mailRetryArm only pulls
// the alarm sooner, so a retry later than this tick left the tick in place, and the back-off then extended it by up to
// 5 minutes past the retry. The next retry (drainRetries next) is now one more next-due event: the back-off stops there.
test('#1059: the back-off never passes the next mail retry, and a retry already due runs the leg', () => {
	const now = 1_000_000_000_000;
	const base = { now, intervalMs: 60_000, streak: 3, wp: { due: false, next: null }, as: { known: true, next: null } };
	const off = idleDecision(base);
	assert.equal(off.alarmAt, now + 5 * 60_000, 'no retry: the full back-off');
	const r = idleDecision({ ...base, mailNext: now + 120_000 });
	assert.equal(r.alarmAt, now + 120_000, 'stops at the retry');
	const soon = idleDecision({ ...base, mailNext: now + 10_000 });
	assert.equal(soon.alarmAt, now + 60_000, 'never sooner than one interval (the drain already armed a sooner retry)');
	const late = idleDecision({ ...base, mailNext: now + 30 * 60_000 });
	assert.equal(late.alarmAt, now + 5 * 60_000, 'a retry past the back-off does not shorten it');
});
test('#1059 index.js: the alarm keeps the drain next retry and the gate passes it to idleDecision', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /this\.mailNext = drained && drained !== TIMED_OUT \? drained\.next : null;/);
	assert.match(src, /idleDecision\(\{ now, intervalMs: Number\(env\.CRON_INTERVAL_MS \|\| 60000\), streak: Number\(st\.n\) \|\| 0, emailRush: false, wp, as, mailNext: this\.mailNext \}\)/);
});

// #1059 at its rebase onto #1055 (agreed): on approach A a page request runs in the WORKER, so the object's request-path
// pullIn never sees a post it schedules. The Cron Trigger tick (every minute) now pulls a backed-off alarm back in, so A
// keeps the gate's saving (no PHP boot when nothing is due) and a schedule from a request is picked up within an interval.
test('#1059 pullIn records who pulled (by), default request-pull', async () => {
	const { pullIn, ALARM_SET_KEY } = await import('../alarm-arm.mjs');
	const mk = (alarm) => { const m = new Map(); return { getAlarm: async () => alarm, setAlarm: async (t) => { alarm = t; }, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, m }; };
	const now = 1_000_000;
	let s = mk(now + 300_000);
	assert.deepEqual(await pullIn(s, now, 60_000, 'a-cron-tick'), { pulled: true, was: now + 300_000 });
	assert.equal(await s.getAlarm(), now + 60_000);
	assert.equal(s.m.get(ALARM_SET_KEY).by, 'a-cron-tick');
	s = mk(now + 300_000);
	await pullIn(s, now, 60_000);
	assert.equal(s.m.get(ALARM_SET_KEY).by, 'request-pull');
	s = mk(now + 30_000);
	assert.deepEqual(await pullIn(s, now, 60_000, 'a-cron-tick'), { pulled: false }, 'a sooner alarm is never moved');
});
// #1164 lever: the tick still pulls a backed-off alarm in after its watchdog re-arm, but only when tickAlarmPlan says so
// (work due, an alarm the idle gate did not set, or an unreadable due state); tests/idle-tick.test.mjs pins the plan.
test('#1059 index.js: the approach A cron tick pulls a backed-off alarm in, after its watchdog re-arm, when the plan says pull', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const w = src.indexOf('const watch = await snapshotRearm(this.ctx.storage, Date.now(), Number(env.CRON_INTERVAL_MS || 60000));');
	const plan = src.indexOf('const plan = tickAlarmPlan(', w);
	const pull = src.indexOf("if (plan.action === 'pull') pulled = await pullIn(this.ctx.storage, tickNow, tickIv, 'a-cron-tick');", plan);
	assert.ok(w > 0 && plan > w && pull > plan, 'watchdog, then the plan, then the pull');
});
