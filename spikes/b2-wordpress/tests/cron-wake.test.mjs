// node --test spikes/b2-wordpress/tests/cron-wake.test.mjs (#1360)
// After a deploy, an idle approach A cron object can sit on an alarm the old build parked up to IDLE_MAX_MS
// (5 min) ahead, so the first tick on the new build waits that long (#1354, measured on cf759hw). The operator
// route /_cron-wake pulls that alarm in to now through pullIn. It does not run a cron leg. The object's own
// alarm runs the tick. No spike token gets the existing 403. A_CRON off answers and changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALARM_SET_KEY } from '../alarm-arm.mjs';
import { IDLE_MAX_MS } from '../cron-idle.mjs';
import { cronObjectWake, cronWakeRoute, wakeCronAlarm, CRON_WAKE_PATH } from '../a-cron.mjs';

const now = 1_700_000_000_000;
const on = { A_CRON: 'on', PHP_RUNTIME: { idFromName() {}, get() {} } };

function fakeStorage(initial) {
	let alarm = initial;
	const m = new Map();
	const calls = [];
	return {
		calls,
		m,
		getAlarm: async () => alarm,
		setAlarm: async (t) => { calls.push(['setAlarm', t]); alarm = t; },
		put: async (k, v) => { calls.push(['put', k]); m.set(k, v); },
		get: async (k) => m.get(k),
	};
}

function wake(storage, extra = {}) {
	return cronObjectWake({
		env: on,
		storage,
		now,
		method: 'POST',
		wakeHeader: '1',
		spikeOk: true,
		...extra,
	});
}

test('#1360 no spike token: the existing 403, and the alarm is not moved', async () => {
	const s = fakeStorage(now + IDLE_MAX_MS);
	const r = await wake(s, { spikeOk: false });
	assert.equal(r.status, 403);
	assert.equal(await s.getAlarm(), now + IDLE_MAX_MS);
	assert.deepEqual(s.calls, []);
	const bad = await wake(s, { wakeHeader: null });
	assert.equal(bad.status, 403);
	assert.deepEqual(s.calls, []);
});

test('#1360 a parked alarm is pulled in to now, through pullIn, and a second wake does not move it again', async () => {
	const s = fakeStorage(now + IDLE_MAX_MS);
	const a = await wake(s);
	assert.equal(a.status, 200);
	assert.equal(a.body.ok, true);
	assert.equal(a.body.pulled, true);
	assert.equal(a.body.at, now);
	assert.equal(a.body.was, now + IDLE_MAX_MS);
	assert.equal(await s.getAlarm(), now);
	assert.equal(s.m.get(ALARM_SET_KEY).by, 'cron-wake');
	assert.deepEqual(s.calls.filter((c) => c[0] === 'setAlarm'), [['setAlarm', now]]);
	const b = await wake(s);
	assert.equal(b.status, 200);
	assert.equal(b.body.ok, true);
	assert.equal(b.body.pulled, false);
	assert.equal(b.body.at, now);
	assert.equal(s.calls.filter((c) => c[0] === 'setAlarm').length, 1, 'idempotent: already at now');
});

test('#1360 an alarm already due, or none, is left alone', async () => {
	const due = fakeStorage(now - 1000);
	const d = await wakeCronAlarm(due, now);
	assert.equal(d.pulled, false);
	assert.equal(await due.getAlarm(), now - 1000);
	assert.deepEqual(due.calls, []);
	const none = fakeStorage(null);
	const n = await wakeCronAlarm(none, now);
	assert.equal(n.ok, true);
	assert.equal(n.pulled, false);
	assert.equal(n.at, null);
	assert.deepEqual(none.calls, []);
});

test('#1360 A_CRON off answers and does nothing', async () => {
	const s = fakeStorage(now + IDLE_MAX_MS);
	const r = await wake(s, { env: { A_CRON: 'off', PHP_RUNTIME: on.PHP_RUNTIME } });
	assert.equal(r.status, 200);
	assert.deepEqual(r.body, { ok: false, cron: 'off' });
	assert.equal(await s.getAlarm(), now + IDLE_MAX_MS);
	assert.deepEqual(s.calls, []);
	assert.equal(cronWakeRoute({ A_CRON: 'off', PHP_RUNTIME: on.PHP_RUNTIME }), 'off');
	assert.equal(cronWakeRoute({ A_CRON: 'on' }), 'off', 'no PHP_RUNTIME binding: do not call an object');
	assert.equal(cronWakeRoute({ A_CRON: 'on', PHP_IN_DO: 'on', PHP_RUNTIME: on.PHP_RUNTIME }), 'off');
	assert.equal(cronWakeRoute(on), 'wake');
});

test('#1360 the wake function only pulls the alarm in; it does not run a cron leg', () => {
	const src = readFileSync(new URL('../a-cron.mjs', import.meta.url), 'utf8');
	const start = src.indexOf('export async function wakeCronAlarm');
	const end = src.indexOf('\nexport ', start + 10);
	const fn = src.slice(start, end);
	assert.match(fn, /pullIn\(storage, now, 0, 'cron-wake'\)/);
	assert.doesNotMatch(fn, /runCron|alarm\(|cronIdle|snapshotRearm|runMediaSweep|armBeforeRun/);
	assert.equal(CRON_WAKE_PATH, '/_cron-wake');
});

test('#1360 the gateway route is after the spike gate, cron off does not fetch, and neither side runs a leg', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const gate = src.lastIndexOf("if (url.pathname.startsWith('/_') && !spikeOk) return new Response('forbidden', { status: 403 });");
	const route = src.indexOf('if (url.pathname === CRON_WAKE_PATH)');
	assert.ok(gate > 0 && route > gate, 'public /_cron-wake is after the gateway spike gate (no token: 403)');
	const block = src.slice(route, src.indexOf('if (env.MEDIA &&', route));
	assert.match(block, /cronWakeRoute\(env\) !== 'wake'/);
	assert.ok(block.indexOf("cron: 'off'") < block.indexOf('stub.fetch'), 'cron off answers before any object call');
	assert.doesNotMatch(block, /runCron|this\.alarm\(|cronIdle\(/);
	const obj = src.indexOf('objectUrl.pathname === CRON_WAKE_PATH');
	// Stop before the tick's own comment: that comment names armBeforeRun and snapshotRearm, and it is not this route.
	const objBlock = src.slice(obj, src.indexOf('\t\t// #855:', obj));
	assert.match(objBlock, /cronObjectWake\(/);
	assert.doesNotMatch(objBlock, /runCron|this\.alarm\(|cronIdle\(|snapshotRearm|runMediaSweep|armBeforeRun/);
	assert.ok(obj < src.indexOf('objectUrl.pathname === CRON_TICK_PATH'), 'the wake is not the cron tick');
});
