// alarm-arm.mjs (issue #291): a stale alarm no longer blocks the cron for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldArmAlarm, STALE_MS, armBeforeRun, rearm, recordAlarmFatal, ALARM_FATAL_KEY, snapshotRearm, setAlarmRecorded, ALARM_SET_KEY, emailRushDue, emailAlarmAt, EMAIL_RUSH_MS, EMAIL_DUE_MAX_MS } from '../alarm-arm.mjs';
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
test('armBeforeRun sets now + interval, records it (#291: when and by whom), and flushes both, in that order', async () => {
	const calls = [];
	const storage = { setAlarm: async (t) => calls.push(['setAlarm', t]), put: async (k, v) => calls.push(['put', k, v]), sync: async () => calls.push(['sync']) };
	const at = await armBeforeRun(storage, now, 60_000);
	assert.equal(at, now + 60_000);
	assert.deepEqual(calls, [['setAlarm', now + 60_000], ['put', ALARM_SET_KEY, { at: now + 60_000, setAt: now, by: 'tick' }], ['sync']]);
});

test('armBeforeRun works on a storage without sync()', async () => {
	const calls = [];
	await armBeforeRun({ setAlarm: async (t) => calls.push(t), put: async () => {} }, now, 1000);
	assert.deepEqual(calls, [now + 1000]);
});

// #291, Cloudflare case 02430361 (2026-11-16): support asks for the UTC time an alarm was SET. getAlarm() says only
// when it is due, so every set records {at, setAt, by} under ALARM_SET_KEY (/_purgestate reports it).
test('setAlarmRecorded sets the alarm and records when, for when, and by whom', async () => {
	const m = new Map(); const calls = [];
	const storage = { setAlarm: async (t) => calls.push(['setAlarm', t]), put: async (k, v) => { calls.push(['put', k]); m.set(k, v); } };
	await setAlarmRecorded(storage, now + 5000, now, 'purge-request');
	assert.deepEqual(calls, [['setAlarm', now + 5000], ['put', ALARM_SET_KEY]]);
	assert.deepEqual(m.get(ALARM_SET_KEY), { at: now + 5000, setAt: now, by: 'purge-request' });
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
	return { calls, getAlarm: async () => at, deleteAlarm: async () => calls.push(['deleteAlarm']), setAlarm: async (t) => calls.push(['setAlarm', t]), put: async (k, v) => calls.push(['put', k, v]) };
};
test('rearm: no alarm -> set only, recorded as a request arm', async () => {
	const s = fakeStorage(null);
	assert.deepEqual(await rearm(s, now, 60_000), { armed: true, stale: false, was: null });
	assert.deepEqual(s.calls, [['setAlarm', now + 60_000], ['put', ALARM_SET_KEY, { at: now + 60_000, setAt: now, by: 'request' }]]);
});
test('rearm: THE STUCK CASE, a stale alarm -> deleteAlarm THEN setAlarm, recorded as request-stale', async () => {
	const was = Date.parse('2026-11-11T19:14:26Z');
	const s = fakeStorage(was);
	assert.deepEqual(await rearm(s, now, 60_000), { armed: true, stale: true, was });
	assert.deepEqual(s.calls, [['deleteAlarm'], ['setAlarm', now + 60_000], ['put', ALARM_SET_KEY, { at: now + 60_000, setAt: now, by: 'request-stale' }]]);
});
test('rearm: a future or just-due alarm is untouched', async () => {
	for (const at of [now + 60_000, now - 30_000]) {
		const s = fakeStorage(at);
		assert.deepEqual(await rearm(s, now, 60_000), { armed: false });
		assert.deepEqual(s.calls, []);
	}
});
test('index.js: every alarm it sets is recorded (no bare storage.setAlarm), and /_purgestate reports the record', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.equal(/\.storage\.setAlarm\(/.test(src), false, 'no bare this.ctx.storage.setAlarm( in index.js');
	assert.equal((src.match(/await setAlarmRecorded\(this\.ctx\.storage/g) || []).length, 4, 'the purge request, the purge retry, the budget wait, and the email-due retry');
	const ps = src.slice(src.indexOf("url.pathname === '/_purgestate'"), src.indexOf("url.pathname === '/_purgestate'") + 600);
	assert.ok(/alarmSet: \(await this\.ctx\.storage\.get\(ALARM_SET_KEY\)\) \|\| null/.test(ps), '/_purgestate reports alarmSet');
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
test('index.js: a failed cron run is stored in the cron record, not only logged', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const i = src.indexOf("console.log(JSON.stringify({ m: 'cron', error:");
	assert.ok(i >= 0);
	assert.ok(/cst\.cron = \{ t: Date\.now\(\), error:/.test(src.slice(i, i + 600)), 'the catch writes cron.error');
});

// #841: a fully edge-cached site, where no request reaches the object, got no cron back after an alarm deletion
// (Cloudflare case 02430361: an alarm past its retry budget is deleted). The daily /_dbsnapshot reaches every object,
// so it re-arms: the same rearm as a request, ONLY a re-arm, never a cron run inline.
const fakeAlarm = (initial) => {
	let at = initial; const calls = [];
	return { calls, getAlarm: async () => at, deleteAlarm: async () => { calls.push('deleteAlarm'); at = null; }, setAlarm: async (t) => { calls.push('setAlarm'); at = t; }, put: async () => {} };
};
test('#841 THE CASE: no alarm, and the only request in a day is /_dbsnapshot: it leaves an alarm set', async () => {
	const s = fakeAlarm(null);
	const r = await snapshotRearm(s, now, 60_000);
	assert.deepEqual(r, { state: 'none', at: now + 60_000 });
	assert.equal(await s.getAlarm(), now + 60_000);
});
test('#841: a long-past (stale) alarm is replaced, and reported stale', async () => {
	const s = fakeAlarm(now - STALE_MS - 1);
	assert.deepEqual(await snapshotRearm(s, now, 60_000), { state: 'stale', at: now + 60_000 });
	assert.deepEqual(s.calls, ['deleteAlarm', 'setAlarm']);
});
test('#841: a future alarm is left alone, and reported ok', async () => {
	const s = fakeAlarm(now + 30_000);
	assert.deepEqual(await snapshotRearm(s, now, 60_000), { state: 'ok', at: now + 30_000 });
	assert.deepEqual(s.calls, []);
});
test('index.js #841: the snapshot path re-arms (snapshotRearm) after its token gate and BEFORE any other return, passes the result to takeSnapshot, and runs no cron', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const i = src.indexOf('if (url.pathname === SNAPSHOT_PATH) {');
	assert.ok(i >= 0);
	const end = src.indexOf('\n\t\t}\n', i);
	const branch = src.slice(i, end);
	const gate = branch.indexOf("if (gate !== 'ok') return gateResponse(gate);");
	const arm = branch.indexOf('await snapshotRearm(this.ctx.storage');
	assert.ok(gate >= 0 && arm > gate, 'snapshotRearm comes after the token gate');
	assert.ok(arm < branch.indexOf("error: 'no-db-or-bucket'"), 'and before the no-db return');
	assert.ok(arm < branch.indexOf('takeSnapshot('), 'and before the snapshot');
	assert.ok(/takeSnapshot\(\{[^}]*alarm: snapAlarm/.test(branch.replace(/\n/g, ' ')), 'the result goes to takeSnapshot');
	assert.equal(/alarmRun\(|runCron\(|this\.alarm\(/.test(branch), false, 'no cron runs inline on the snapshot request');
});

// #846 review (the lead, 2026-11-16): the snapshot re-arms BEFORE its import-held return, so a snapshot taken mid-import
// can arm an alarm that fires while the import still holds the site. That is safe only because alarmRun refuses the
// cron then: its gate requires !importHeld, and every PHP boot (boot, runCron) is inside that gate.
test('index.js #846: an alarm during an import boots no PHP (cronGo needs !importHeld; boot and runCron only inside if (cronGo))', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const r = src.indexOf('async alarmRun() {');
	const body = src.slice(r, src.indexOf('async fetch(raw)', r));
	assert.ok(/const importHeld = cronHeld\(await this\.ctx\.storage\.get\(IMPORT_HOLD_KEY\)/.test(body), 'alarmRun reads the import hold');
	const gateLine = body.split('\n').find((l) => l.includes('const cronGo ='));
	assert.ok(gateLine && gateLine.includes('!importHeld'), 'the cron gate requires !importHeld');
	const open = body.indexOf('if (cronGo) {');
	assert.ok(open > 0, 'the cron leg is inside if (cronGo)');
	for (const call of ['runCron(', 'boot(cronOrigin)']) {
		const at = body.indexOf(call);
		assert.ok(at > open, call + ' only after if (cronGo) opens');
	}
	assert.equal(body.slice(0, open).search(/\bboot\(|runCron\(|withPhp\(/), -1, 'no PHP before the gate');
});

test('#969: a fresh email-due time is a rush; a missing or old one is not', () => {
	assert.equal(emailRushDue(now, now), true);
	assert.equal(emailRushDue(now - 1000, now), true);
	assert.equal(emailRushDue(0, now), false);
	assert.equal(emailRushDue(null, now), false);
	assert.equal(emailRushDue(now - EMAIL_DUE_MAX_MS, now), false);
});

test('#969: pull a far alarm in; leave one that is already sooner', () => {
	assert.equal(emailAlarmAt(null, now), now + EMAIL_RUSH_MS);
	assert.equal(emailAlarmAt(now + 60_000, now), now + EMAIL_RUSH_MS);
	assert.equal(emailAlarmAt(now + 500, now), null);
});
