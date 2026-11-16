// #705 second review, findings 3 and 7: a cron leg whose boot the gate refused is DEFERRED, not done, and a
// cron leg never runs on a runtime that was released while it waited for the PHP lock.
// node --test tests/cron-deferred.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cronRunStart, cronRunDone, cronRunDeferred } from '../cron-health.mjs';

test('a deferred leg closes the run record without resetting the deaths, and says so', () => {
	const rec = { startedAt: 1, done: false, deaths: 3 };
	const d = cronRunDeferred(rec, 50, 'boot-refused');
	assert.deepEqual([d.done, d.deaths, d.deferred, d.deferredAt], [true, 3, 'boot-refused', 50], 'a deferral reset the death count or hid itself');
	assert.equal(cronRunDone(rec, 50).deaths, 0, 'a finished leg still resets');
	// the next leg does not count a deferral as a death (done is true)
	assert.equal(cronRunStart(d, 60).rec.deaths, 3);
});

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
test('index.js: the alarm records a deferred leg as deferred (no cronRunDone, no done:1 line, a deferred summary)', () => {
	const leg = src.slice(src.indexOf('async alarmRun() {'), src.indexOf('await this.ctx.storage.put(PURGE_STATE_KEY, cst);'));
	assert.match(leg, /cronRunDeferred\(/, 'the deferral is not recorded as such');
	assert.match(leg, /if \(cr && cr\.deferred\)/, 'the summary does not branch on the deferral');
});

test('index.js: runCron resolves its runtime INSIDE the PHP lock (#603 B): no cron boot outside it', () => {
	const rc = src.slice(src.indexOf('async function runCron('), src.indexOf('async function toPhpObject('));
	const w = rc.indexOf('return withPhp(async () => {');
	assert.ok(w >= 0);
	assert.ok(rc.indexOf('const { php } = await getBooted();') > w, 'the cron runtime is resolved outside the lock');
	assert.ok(!/await \(bootPromise \?\?= boot\(cronOrigin\)\)/.test(src), 'the alarm still boots outside the lock');
});
