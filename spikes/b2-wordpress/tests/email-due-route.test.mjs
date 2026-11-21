// #1215: a queued WooCommerce email (an Action Scheduler action) ran 12 to 122 s after the order on cf759hl, against the
// spec's 30 s mail poll. Action Scheduler's own async runner is off by design (#358: our bounded alarm is its only
// runner). #969's fast path is php/woo-edge.php's emailDue, which pulls the cron alarm 1.5 s out. But it armed only
// where the request had ctx.storage: on approach A an order runs in the Worker (no storage) or on an overflow pool
// object, and the cron is the A_CRON object, so the wake was dropped and the email waited for the minute tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { emailDueRoute, EMAIL_DUE_PATH, EMAIL_DUE_HEADER } from '../a-cron.mjs';

const A = { A_CRON: 'on', PHP_RUNTIME: {} };
const A_OFF = { A_CRON: 'off', PHP_RUNTIME: {} };
const DOSQL = { PHP_IN_DO: 'on', DB_IN_DO: 'on' };

test('#1215 approach A: a Worker request (no storage) sends the wake to the cron object', () => {
	assert.equal(emailDueRoute({ storage: null, overflowed: false, env: A }), 'a-cron');
});
test('#1215 approach A: an overflowed pool request sends it to the cron object, never arms its own (#1186)', () => {
	assert.equal(emailDueRoute({ storage: {}, overflowed: true, env: A }), 'a-cron');
});
test('#1215 the object that owns the cron (b-dosql, or the A_CRON object running a leg) arms its own alarm, as #969', () => {
	assert.equal(emailDueRoute({ storage: {}, overflowed: false, env: DOSQL }), 'local');
	assert.equal(emailDueRoute({ storage: {}, overflowed: false, env: A }), 'local');
});
test('#1215 a cron-off approach A build arms nothing, anywhere (#1186)', () => {
	assert.equal(emailDueRoute({ storage: {}, overflowed: false, env: A_OFF }), 'none');
	assert.equal(emailDueRoute({ storage: null, overflowed: false, env: A_OFF }), 'none');
	assert.equal(emailDueRoute({ storage: {}, overflowed: true, env: A_OFF }), 'none');
});
test('#1215 no cron object binding: nothing to send to', () => {
	assert.equal(emailDueRoute({ storage: null, overflowed: false, env: { A_CRON: 'on' } }), 'none');
	assert.equal(emailDueRoute({ storage: null, overflowed: false, env: null }), 'none');
});
test('#1215 index.js: the arm site routes; the cron object path is gated and does #969; the Worker 404s it', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.equal(EMAIL_DUE_PATH, '/_email-due');
	assert.equal(EMAIL_DUE_HEADER, 'x-pf-email-due');
	assert.match(src, /const route = emailDueRoute\(\{ storage: ctx && ctx\.storage, overflowed: Boolean\(ctx && ctx\.overflowed\), env: ENV \}\);/);
	assert.match(src, /if \(route === 'local'\) \{/);
	// #1238 (the lead's ruling, the #1225 rule): in the Worker the hand-off goes to waitUntil (live it cost 215 to 441 ms
	// awaited in every order); in an object (a pool object) it is still awaited, since waitUntil does not keep it alive.
	assert.match(src, /else if \(route === 'a-cron'\) \{\n\t\t\t\t\tif \(ctx && !ctx\.inObject && typeof ctx\.waitUntil === 'function'\) ctx\.waitUntil\(emailDueToCron\(ENV\)\);\n\t\t\t\t\telse await emailDueToCron\(ENV\);\n\t\t\t\t\}/, 'waitUntil in the Worker, awaited in an object');
	assert.equal(/else if \(route === 'a-cron'\) await emailDueToCron\(ENV\);/.test(src), false, 'no longer awaited in the Worker');
	const at = src.indexOf('if (objectUrl.pathname === EMAIL_DUE_PATH) {');
	assert.ok(at > 0, 'the cron object handles the path');
	const h = src.slice(at, at + 900);
	assert.match(h, /raw\.headers\.get\(EMAIL_DUE_HEADER\) !== '1' \|\| raw\.method !== 'POST' \|\| !approachACronEnabled\(env\)/);
	assert.match(h, /await this\.ctx\.storage\.put\(EMAIL_DUE_KEY, nowDue\);/);
	assert.match(h, /emailAlarmAt\(await this\.ctx\.storage\.getAlarm\(\), nowDue\)/, 'only sooner, never later (#1176 backoff intact)');
	assert.match(h, /setAlarmRecorded\(this\.ctx\.storage, dueAt, nowDue, 'email-due'\)/);
	assert.match(src, /if \(url\.pathname === EMAIL_DUE_PATH\) return new Response\('Not Found', \{ status: 404 \}\);/);
	const send = src.slice(src.indexOf('async function emailDueToCron(env) {'));
	assert.match(send.slice(0, 700), /idFromName\(CRON_OBJECT_NAME\)/);
	assert.match(send.slice(0, 700), /AbortSignal\.timeout\(EMAIL_DUE_SEND_MS\)/, 'bounded: the order answer never waits long on it');
});
