import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aCronObjectOff } from '../a-cron.mjs';

// #1186 (strummer, cf759hx): with the Cron Trigger cleared (A_CRON=0), the cron object's OWN alarm chain survived. It
// woke, skipped as idle and RE-ARMED (2 alarms in 5 min), so due WP-Cron or Action Scheduler work would still run legs.
// On approach A a PhpRuntime is only the cron object or a pool object (a pool request never arms the alarm), so on a
// cron-off build an alarm there has no work: it deletes itself, and nothing on that object arms one again.
test('#1186 aCronObjectOff: an approach A object on a cron-off build', () => {
	assert.equal(aCronObjectOff({}), true, 'A_CRON absent, approach A');
	assert.equal(aCronObjectOff({ A_CRON: 'off' }), true);
	assert.equal(aCronObjectOff({ A_CRON: 'on' }), false, 'the cron is on');
	assert.equal(aCronObjectOff({ PHP_IN_DO: 'on' }), false, 'b-do: the site object runs its cron and purges by alarm');
	assert.equal(aCronObjectOff({ PHP_IN_DO: 'on', DB_IN_DO: 'on' }), false, 'b-dosql');
	assert.equal(aCronObjectOff({ DB_IN_DO: 'on' }), false);
	assert.equal(aCronObjectOff(null), false, 'no env: never delete');
});
test('#1186 index.js: the alarm checks FIRST, deletes itself and returns, logging cron-off once; requests never arm it', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const a = src.indexOf('\tasync alarm() {');
	const body = src.slice(a, a + 2000);
	const off = body.indexOf('if (aCronObjectOff(this.env)) {');
	assert.ok(off > 0, 'checked in the alarm');
	assert.ok(off < body.indexOf('armBeforeRun('), 'before the next tick is armed');
	assert.ok(off < body.indexOf('CRON_ALARM_BUILD_KEY'), 'before anything is written');
	assert.match(body.slice(off, off + 400), /await this\.ctx\.storage\.deleteAlarm\(\);[\s\S]*m: 'cron-off'[\s\S]*return;/);
	assert.match(src, /const armsCron = !url\.pathname\.startsWith\('\/_'\) && !overflowed && !aCronObjectOff\(env\);/);
});
// #1186 review of every arm site: the #969 email-due wake armed the alarm through ctx.storage on ANY object, an
// overflowed pool request included, against "an overflowed request never arms the cron alarm" (#296 (3)). On a
// cron-off build that alarm would run until it fired; with the cron on, a pool object could run cron legs.
test('#1186 the email-due wake never arms from an overflowed request or on a cron-off approach A build', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	// #1215: the guard is emailDueRoute (a-cron.mjs, tests/email-due-route.test.mjs): an overflowed request is never 'local', and a cron-off build is 'none'.
	assert.match(src, /const route = emailDueRoute\(\{ storage: ctx && ctx\.storage, overflowed: Boolean\(ctx && ctx\.overflowed\), env: ENV \}\);/);
});
// #1194 review (rollins): the email-due guard reads ctx.overflowed, but on main the object's ctx did not carry it (it
// came with #1157's self-fetch work), so the pool half of the guard was always true. Pin both ends: the object puts the
// overflow mark on the ctx it hands to handle(), and the guard reads that field.
test('#1186 the object ctx carries overflowed, so the email-due guard can see a pool request', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /const ctx = \{ inObject: true, overflowed, storage: this\.ctx\.storage,/);
	// #1215: the guard is emailDueRoute (a-cron.mjs, tests/email-due-route.test.mjs): an overflowed request is never 'local', and a cron-off build is 'none'.
	assert.match(src, /const route = emailDueRoute\(\{ storage: ctx && ctx\.storage, overflowed: Boolean\(ctx && ctx\.overflowed\), env: ENV \}\);/);
});
