// node --test spikes/b2-wordpress/tests/cron-health.test.mjs (#471)
// A cron leg that keeps dying backs off, and says which job it was running and PHP's own error.
// The decisions are cron-health.mjs; the wiring in index.js is read from the source (index.js
// loads php-wasm and cannot be imported under node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cronBackoffMs, cronBackoff, cronRunStart, cronRunDone, cronMarkOf, cronFatalOf, BACKOFF_MAX_MS } from '../cron-health.mjs';

const MIN = 60000;
const T = 1_800_000_000_000;

test('cronBackoffMs: none for 0 or 1 death, then 2, 4, 8 ... min, at most 60', () => {
	assert.equal(cronBackoffMs(0), 0);
	assert.equal(cronBackoffMs(1), 0);
	assert.equal(cronBackoffMs(2), 2 * MIN);
	assert.equal(cronBackoffMs(3), 4 * MIN);
	assert.equal(cronBackoffMs(4), 8 * MIN);
	assert.equal(cronBackoffMs(7), BACKOFF_MAX_MS);
	assert.equal(cronBackoffMs(50), BACKOFF_MAX_MS);
});

test('THE PFT1A LOOP: a tick that dies every minute stops re-firing every minute', () => {
	// Simulate: every leg dies (never marked done). Ticks every minute. Count the legs that run in 60 min.
	let rec = null; const ran = [];
	for (let m = 0; m < 60; m++) {
		const now = T + m * MIN;
		if (cronBackoff(rec, now).waitMs) continue;
		rec = cronRunStart(rec, now).rec; // it starts, then dies: no cronRunDone
		ran.push(m);
	}
	assert.deepEqual(ran.slice(0, 3), [0, 1, 3], 'deaths 1 then 2: the third leg waits 2 min');
	assert.ok(ran.length <= 7, `legs in 60 min: ${ran.length} (was 60)`);
});

test('a finished leg resets the count; one death alone does not wait', () => {
	let rec = cronRunStart(null, T).rec; // dies
	assert.equal(cronBackoff(rec, T + MIN).waitMs, 0, 'one death: next minute runs');
	const s2 = cronRunStart(rec, T + MIN);
	assert.equal(s2.died, true);
	assert.equal(s2.rec.deaths, 1);
	rec = cronRunDone(s2.rec, T + MIN + 5000);
	assert.equal(rec.deaths, 0);
	assert.equal(cronBackoff(rec, T + 2 * MIN).waitMs, 0);
	assert.equal(cronRunStart(rec, T + 2 * MIN).died, false);
});

test('the run that died keeps its last mark and fatal for the next record', () => {
	const r1 = { ...cronRunStart(null, T).rec, lastMark: { k: 'wp', hook: 'do_pings' }, lastFatal: { msg: 'Allowed memory size' } };
	const s = cronRunStart(r1, T + MIN);
	assert.deepEqual(s.rec.prevMark, { k: 'wp', hook: 'do_pings' });
	assert.deepEqual(s.rec.prevFatal, { msg: 'Allowed memory size' });
	assert.equal(s.rec.lastMark, null);
});

test('cronMarkOf and cronFatalOf clean and bound what PHP sends', () => {
	assert.deepEqual(cronMarkOf({ k: 'as', hook: 'wpforms_admin_notifications_update', id: 42 }), { k: 'as', hook: 'wpforms_admin_notifications_update', id: 42 });
	assert.deepEqual(cronMarkOf({ k: 'x', hook: 'a b<script>', id: -1 }), { k: '?', hook: 'abscript', id: 0 });
	assert.equal(cronMarkOf({ hook: 'h'.repeat(500) }).hook.length, 120);
	assert.deepEqual(cronMarkOf(null), { k: '?', hook: '?', id: 0 });
	const f = cronFatalOf({ type: 1, msg: 'x\ny'.repeat(400), file: '/wordpress/wp-content/plugins/p/a.php', line: 7 });
	assert.equal(f.msg.length, 300);
	assert.ok(!/\n/.test(f.msg));
	assert.equal(f.file, 'wp-content/plugins/p/a.php');
	assert.equal(f.line, 7);
});

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('index.js: the record is written and synced BEFORE the run, and marked done after', () => {
	const run = src.indexOf('async alarmRun() {');
	const body = src.slice(run, src.indexOf('\n\tasync fetch(raw) {', run));
	assert.match(body, /const bo = cronBackoff\(prevRun, Date\.now\(\)\);/);
	assert.match(body, /const cronGo = legDue && !bo\.waitMs && !importHeld/);
	const put = body.indexOf('await this.ctx.storage.put(CRON_RUN_KEY, runStart.rec);');
	const sync = body.indexOf('await this.ctx.storage.sync();', put);
	const runs = body.indexOf('cr = await runCron(', put);
	const done = body.indexOf('cronRunDone(', runs);
	assert.ok(put > 0 && sync > put && runs > sync && done > runs, 'put, sync, run, done');
	assert.match(body, /skipped: 'backoff'/);
	assert.ok(/cronRun: \(await this\.ctx\.storage\.get\(CRON_RUN_KEY\)\)/.test(src), '/_purgestate shows the record');
});

test('index.js: PHP marks each job BEFORE it runs, and sends its fatal from a shutdown function', () => {
	const i = src.indexOf('async function runCron(');
	const php = src.slice(src.indexOf('code: `', i), src.indexOf('` });', i));
	assert.match(php, /register_shutdown_function\( function \(\) \{\s*\$e = error_get_last\(\);/);
	assert.match(php, /'cronFatal' =>/);
	const asMark = php.indexOf("$skyphusion_cron_mark( 'as', $as_h, $as_id );");
	const asRun = php.indexOf('$as_runner->process_action( $as_id');
	assert.ok(asMark > 0 && asRun > asMark, 'the AS mark before process_action');
	const wpMark = php.indexOf("$skyphusion_cron_mark( 'wp', $hook );");
	const wpRun = php.indexOf("do_action_ref_array( $hook, $ev['args'] );");
	assert.ok(wpMark > 0 && wpRun > wpMark, 'the WP-Cron mark before the hook runs');
	assert.ok(php.indexOf('register_shutdown_function') < php.indexOf("require '/wordpress/wp-load.php';"), 'the shutdown function is in place before WordPress loads');
	assert.match(src, /if \(m\.cronMark\) \{\s*const mk = cronMarkOf\(m\.cronMark\);\s*console\.log/);
	assert.match(src, /if \(m\.cronFatal\) \{\s*const f = cronFatalOf\(m\.cronFatal\);\s*console\.log/);
});
