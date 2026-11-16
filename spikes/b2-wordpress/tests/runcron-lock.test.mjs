// node --test spikes/b2-wordpress/tests/runcron-lock.test.mjs (#720)
// /_runcron used to run inside the request withPhp, and runCron took withPhp again.
// php-lock.mjs is not reentrant, so the inner wait lasted the full stale time and onStale
// dropped the runtime. index.js cannot be imported under node (it imports the wasm engine),
// so this reads the call shape from source and replays it on the real lock with a fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPhpLock } from '../php-lock.mjs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const lockSrc = readFileSync(new URL('../php-lock.mjs', import.meta.url), 'utf8');

// A fake clock: timers run in time order when advanced, with the microtasks between them drained.
// Same shape as tests/php-lock.test.mjs.
function fakeClock() {
	let t = 0;
	let timers = [];
	let seq = 0;
	const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
	return {
		now: () => t,
		setTimer: (fn, ms) => { const id = ++seq; timers.push({ id, at: t + Math.max(0, ms), fn }); return id; },
		clearTimer: (id) => { timers = timers.filter((x) => x.id !== id); },
		async advance(ms) {
			const end = t + ms;
			await flush();
			for (;;) {
				timers.sort((a, b) => a.at - b.at || a.id - b.id);
				const next = timers[0];
				if (!next || next.at > end) break;
				timers.shift();
				t = next.at;
				next.fn();
				await flush();
			}
			t = end;
			await flush();
		},
	};
}

// Replay `locks` nested withPhp acquisitions on the real lock. 1 finishes at once.
// 2 is the #720 defect: the inner wait lasts staleMs, then onStale drops the runtime.
async function simulate(locks) {
	const c = fakeClock();
	const events = [];
	const lock = createPhpLock({ staleMs: 60000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, log: (e) => events.push(e) });
	let acquisitions = 0;
	let drops = 0;
	const booted = true;
	const withPhp = (fn) => {
		acquisitions++;
		return lock.run(fn, { onStale: () => { if (booted) drops++; } });
	};
	const php = async () => 'ok';
	let call = php;
	for (let i = 0; i < locks; i++) {
		const inner = call;
		call = () => withPhp(inner);
	}
	let done = false;
	const p = call().then((v) => { done = true; return v; });
	await c.advance(0);
	const early = done;
	await c.advance(60000);
	const value = await p;
	return { acquisitions, drops, stales: events.filter((e) => e.event === 'stale').length, early, value };
}

// How many withPhp acquisitions the source gives /_runcron, and the alarm.
// Safe shape (#720): the request withPhp still wraps handle, and runCron passes held so its
// own withPhp does not take the lock again. The flag is set only around that call and cleared
// in finally. The alarm does not set it, so runCron's withPhp stays its only lock.
function lockShape(code) {
	const handleAt = code.indexOf('async function handle(');
	const runcronAt = code.indexOf("if (url.pathname === '/_runcron')", handleAt);
	const activateAt = code.indexOf("if (url.pathname === '/_activate')", runcronAt);
	const block = runcronAt >= 0 && activateAt > runcronAt ? code.slice(runcronAt, activateAt) : '';
	const setAt = block.indexOf('runcronHoldsLock = true');
	const callAt = block.indexOf('const r = await runCron(await bootPromise, false, mail);');
	const clearAt = block.indexOf('runcronHoldsLock = false');
	const bracketed = setAt >= 0 && callAt > setAt && clearAt > callAt && block.includes('finally');
	const oneTrue = code.split('runcronHoldsLock = true').length - 1 === 1;

	const runCronFn = code.indexOf('async function runCron(');
	const runCronEnd = code.indexOf('async function preverifyTurnstile(', runCronFn);
	const runCron = code.slice(runCronFn, runCronEnd);
	const passesHeld = runCron.indexOf('return withPhp(async () => {') >= 0 && runCron.includes('}, { held: runcronHoldsLock });');
	const alwaysLocks = runCron.includes('return withPhp(async () => {') && !runCron.includes('held:');

	const withPhpFn = code.slice(code.indexOf('function withPhp('), code.indexOf('function isMediaUpload('));
	const heldReturn = /held = false[\s\S]{0,500}?if \(held\) return fn\(\);/.test(withPhpFn);

	const fetchBody = code.slice(code.indexOf('\tasync fetch(raw) {'), code.indexOf('function phpObjectName('));
	const objectWith = fetchBody.indexOf('const objectRun = await withPhp(');
	const objectNests = objectWith >= 0 && fetchBody.indexOf('await handle(', objectWith) > objectWith;
	const workerNests = code.includes('const workerRun = await withPhp(() => handle(req, env, url, spikeOk, maxBody, ctx)');

	const alarmStart = code.indexOf('async alarmRun()');
	const alarm = code.slice(alarmStart, code.indexOf('\tasync fetch(raw) {', alarmStart));
	const alarmUntouched = alarm.includes('cr = await runCron(await (bootPromise ??= boot(cronOrigin)), cleanDue, mail);')
		&& !alarm.includes('runcronHoldsLock')
		&& !alarm.includes('withPhp(');

	const alarmLocks = alarmUntouched && alwaysLocks || alarmUntouched && passesHeld ? 1 : -1;
	if (passesHeld && heldReturn && bracketed && oneTrue && objectNests && workerNests && alarmUntouched) return { manual: 1, alarm: alarmLocks };
	if (alwaysLocks && callAt >= 0 && objectNests && workerNests && alarmUntouched && !passesHeld) return { manual: 2, alarm: alarmLocks };
	return { manual: -1, alarm: alarmLocks };
}

test('the PHP lock module stays not reentrant (#720)', () => {
	assert.equal(lockSrc.includes('held'), false);
	assert.equal(lockSrc.includes('reentr'), false);
});

test('/_runcron takes the PHP lock once: no stale takeover and no runtime drop (#720)', async () => {
	// Control: two nested acquisitions on the real lock still wait out the stale time and drop.
	// If this does not fail that way, the test cannot see the defect.
	const bug = await simulate(2);
	assert.equal(bug.acquisitions, 2);
	assert.equal(bug.stales, 1, 'control: the inner wait goes stale');
	assert.equal(bug.drops, 1, 'control: onStale drops the runtime');
	assert.equal(bug.early, false, 'control: it does not finish before the stale time');
	assert.equal(bug.value, 'ok');

	const shape = lockShape(src);
	assert.equal(shape.alarm, 1, 'the alarm leg still has one withPhp, the one inside runCron');
	const got = await simulate(shape.manual);
	assert.equal(shape.manual, 1, '/_runcron must not nest withPhp');
	assert.equal(got.acquisitions, 1, 'one acquisition');
	assert.equal(got.stales, 0, 'no stale');
	assert.equal(got.drops, 0, 'no runtime drop');
	assert.equal(got.early, true, 'the cron turn finishes without waiting out the stale time');
	assert.equal(got.value, 'ok');
});
