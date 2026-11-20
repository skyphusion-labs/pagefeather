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
