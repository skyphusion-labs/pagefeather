// node --test spikes/b2-wordpress/tests/runcron-lock.test.mjs (#720)
// /_runcron used to run inside the request withPhp, and runCron took withPhp again.
// php-lock.mjs is not reentrant, so the inner wait lasted the full stale time and onStale
// dropped the runtime. index.js cannot be imported under node (it imports the wasm engine),
// so this reads the call shape from source and replays it on the real lock with a fake clock.
// The overlap replay is the same idea: a module flag is shared by every caller, an explicit { held } is not.
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

// A module-level `let` gates `held` when withPhp (or a call shaped like it) is given that name
// as the held option. A log field in an object that also has `m:` is not that option (ovHeld).
function letsGatingHeld(code) {
	const names = new Set([...code.matchAll(/^let ([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]));
	const gates = new Set();
	for (const m of code.matchAll(/\bheld\s*:\s*([A-Za-z_$][\w$]*)/g)) {
		if (!names.has(m[1])) continue;
		const start = code.lastIndexOf('{', m.index);
		const end = code.indexOf('}', m.index);
		const obj = start >= 0 && end > start ? code.slice(start, end + 1) : '';
		if (/\bm\s*:/.test(obj)) continue;
		gates.add(m[1]);
	}
	return [...gates];
}

// 'module': runCron reads a shared let at its withPhp. 'explicit': only this call is passed { held }.
// (#603: runCron takes a function that resolves the runtime inside its lock; the call shapes below follow it.)
function holdMode(code) {
	if (letsGatingHeld(code).length > 0 || code.includes('let runcronHoldsLock')) return 'module';
	const explicit = code.includes('const r = await runCron(() => (bootPromise ??= boot(origin)), false, mail, { held: true });');
	const runCronFn = code.indexOf('async function runCron(');
	const runCronEnd = code.indexOf('async function preverifyTurnstile(', runCronFn);
	const runCron = runCronFn >= 0 && runCronEnd > runCronFn ? code.slice(runCronFn, runCronEnd) : '';
	const forwards = /\},\s*\{\s*held\s*\}\s*\);/.test(runCron);
	const alarmStart = code.indexOf('async alarmRun()');
	const alarmEnd = code.indexOf('\tasync fetch(raw) {', alarmStart);
	const alarm = alarmStart >= 0 && alarmEnd > alarmStart ? code.slice(alarmStart, alarmEnd) : '';
	const alarmPlain = alarm.includes('cr = await runCron(() => (bootPromise ??= boot(cronOrigin)), cleanDue, mail);') && !alarm.includes('{ held');
	if (explicit && forwards && alarmPlain) return 'explicit';
	return 'unknown';
}

// /_runcron is inside the request withPhp. It awaits boot before runCron reaches its own withPhp.
// An alarm runCron starts in that await. 'module' sets a shared flag first, so the alarm reads
// held and runs PHP with no lock. 'explicit' passes held only on /_runcron's runCron, so the
// alarm takes the lock and waits. PHP turns take 1000 ms on the fake clock.
async function overlap(mode) {
	if (mode !== 'module' && mode !== 'explicit') throw new Error('overlap mode must be module or explicit, not ' + mode);
	const c = fakeClock();
	const events = [];
	const lock = createPhpLock({ staleMs: 60000, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, log: (e) => events.push(e) });
	let phpLive = 0;
	let maxPhp = 0;
	let flag = false;
	let manualDoneAt = null;
	let alarmAt = null;
	let alarmDuringFlag = false;

	const phpTurn = (who) => new Promise((res) => {
		const at = c.now();
		if (who === 'alarm') {
			alarmAt = at;
			alarmDuringFlag = flag;
		}
		phpLive++;
		maxPhp = Math.max(maxPhp, phpLive);
		c.setTimer(() => {
			phpLive--;
			if (who === 'manual') manualDoneAt = c.now();
			res(who);
		}, 1000);
	});

	const withPhp = (fn, { held = false } = {}) => (held ? fn() : lock.run(() => fn()));

	let releaseBoot;
	const bootPromise = new Promise((res) => { releaseBoot = res; });
	let noteReady;
	const ready = new Promise((res) => { noteReady = res; });

	const alarmP = ready.then(() => withPhp(() => phpTurn('alarm'), { held: mode === 'module' ? flag : false }));
	const manualP = withPhp(async () => {
		if (mode === 'module') flag = true;
		try {
			noteReady();
			await bootPromise;
			return await withPhp(() => phpTurn('manual'), { held: mode === 'module' ? flag : true });
		} finally {
			flag = false;
		}
	});

	await c.advance(0);
	releaseBoot(true);
	await c.advance(5000);
	await Promise.all([manualP, alarmP]);
	return {
		maxPhp,
		alarmDuringFlag,
		alarmAt,
		manualDoneAt,
		queued: events.filter((e) => e.event === 'queued').length,
		stales: events.filter((e) => e.event === 'stale').length,
	};
}

// How many withPhp acquisitions the source gives /_runcron, and the alarm.
// One acquisition (#720): the request withPhp still wraps handle, and runCron's own withPhp is
// passed held so it does not take the lock again. The explicit argument is that hold. The module
// flag is also one acquisition; the overlap test is what rejects it. The alarm does not pass
// held, so runCron's withPhp is its only lock.
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
	const explicitCall = block.includes('const r = await runCron(() => (bootPromise ??= boot(origin)), false, mail, { held: true });');

	const runCronFn = code.indexOf('async function runCron(');
	const runCronEnd = code.indexOf('async function preverifyTurnstile(', runCronFn);
	const runCron = code.slice(runCronFn, runCronEnd);
	const passesHeld = runCron.indexOf('return withPhp(async () => {') >= 0 && runCron.includes('}, { held: runcronHoldsLock });');
	const forwardsHeld = runCron.indexOf('return withPhp(async () => {') >= 0 && /\},\s*\{\s*held\s*\}\s*\);/.test(runCron);
	const alwaysLocks = runCron.includes('return withPhp(async () => {') && !runCron.includes('held:') && !forwardsHeld;

	const withPhpFn = code.slice(code.indexOf('function withPhp('), code.indexOf('function isMediaUpload('));
	const heldReturn = /held = false[\s\S]{0,500}?if \(held\) return fn\(\);/.test(withPhpFn);

	const fetchBody = code.slice(code.indexOf('\tasync fetch(raw) {'), code.indexOf('function phpObjectName('));
	const objectWith = fetchBody.indexOf('const objectRun = await withPhp(');
	const objectNests = objectWith >= 0 && fetchBody.indexOf('await handle(', objectWith) > objectWith;
	const workerNests = code.includes('const workerRun = await withPhp(() => withRunCall(callId, () => handle(req, env, url, spikeOk, maxBody, ctx))');

	const alarmStart = code.indexOf('async alarmRun()');
	const alarm = code.slice(alarmStart, code.indexOf('\tasync fetch(raw) {', alarmStart));
	const alarmUntouched = alarm.includes('cr = await runCron(() => (bootPromise ??= boot(cronOrigin)), cleanDue, mail);')
		&& !alarm.includes('runcronHoldsLock')
		&& !alarm.includes('{ held')
		&& !alarm.includes('withPhp(');

	const alarmLocks = alarmUntouched && (alwaysLocks || passesHeld || forwardsHeld) ? 1 : -1;
	const moduleFlag = passesHeld && heldReturn && bracketed && oneTrue;
	const explicit = forwardsHeld && heldReturn && explicitCall && !code.includes('runcronHoldsLock');
	if ((moduleFlag || explicit) && objectNests && workerNests && alarmUntouched) return { manual: 1, alarm: alarmLocks };
	if (alwaysLocks && callAt >= 0 && objectNests && workerNests && alarmUntouched && !passesHeld && !forwardsHeld) return { manual: 2, alarm: alarmLocks };
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

test('control: a shared hold flag lets the alarm run beside /_runcron (#720)', async () => {
	// The defect the overlap test has to be able to see. If this does not overlap, a green
	// result above it would mean nothing.
	const bug = await overlap('module');
	assert.equal(bug.maxPhp, 2, 'control: the alarm PHP overlaps');
	assert.equal(bug.alarmDuringFlag, true, 'control: the alarm ran while the flag was set');
	assert.equal(bug.queued, 0, 'control: the alarm did not take the lock');
	assert.equal(bug.stales, 0, 'control: this is overlap, not a stale takeover');
	assert.ok(bug.alarmAt < bug.manualDoneAt, 'control: the alarm did not wait');
});

test('an alarm runCron started while /_runcron holds the lock waits for it (#720)', async () => {
	const mode = holdMode(src);
	assert.notEqual(mode, 'unknown', 'could not read how runCron decides held');
	const got = await overlap(mode);
	assert.equal(got.alarmDuringFlag, false, `the alarm ran while the flag was set (mode=${mode}, maxPhp=${got.maxPhp}, alarmAt=${got.alarmAt}, manualDoneAt=${got.manualDoneAt}, queued=${got.queued})`);
	assert.equal(got.maxPhp, 1, 'the alarm ran PHP while /_runcron held the runtime');
	assert.equal(got.queued, 1, 'the alarm runCron must queue on the lock');
	assert.ok(Number.isFinite(got.alarmAt) && Number.isFinite(got.manualDoneAt) && got.alarmAt >= got.manualDoneAt, 'the alarm did not wait for the lock');
	assert.equal(got.stales, 0, 'the waiter must not go stale');
	assert.equal(mode, 'explicit', 'the hold is an argument of this runCron call, not a module let');
});

test('no module-level let gates held (#720)', () => {
	assert.deepEqual(letsGatingHeld(src), []);
});
