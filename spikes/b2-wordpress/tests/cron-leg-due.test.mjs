// node --test spikes/b2-wordpress/tests/cron-leg-due.test.mjs (#470)
// A purge alarm (every PURGE_GAP_MS, 15 s, under admin writes) must not boot WordPress for the cron
// leg when the last cron leg started less than CRON_INTERVAL_MS ago. The decision is cron-bound.mjs
// cronLegDue; its wiring in index.js is read from the source (index.js loads php-wasm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cronLegDue, CRON_SLACK_MS } from '../cron-bound.mjs';

const MIN = 60000;

test('cronLegDue: the first run, and a run a full interval later, are due', () => {
	const now = 1_800_000_000_000;
	assert.equal(cronLegDue(undefined, now, MIN), true);
	assert.equal(cronLegDue(0, now, MIN), true);
	assert.equal(cronLegDue(now - MIN, now, MIN), true);
	assert.equal(cronLegDue(now - 5 * MIN, now, MIN), true);
});

test('cronLegDue: the measured pft1a cadence (purge alarms 15 to 30 s apart) is NOT due', () => {
	const now = 1_800_000_000_000;
	for (const ago of [15000, 16000, 30000, 45000]) assert.equal(cronLegDue(now - ago, now, MIN), false, String(ago));
});

test('cronLegDue: the regular tick is not missed by clock jitter (slack), nor starved by a future time', () => {
	const now = 1_800_000_000_000;
	assert.equal(cronLegDue(now - (MIN - CRON_SLACK_MS), now, MIN), true);
	assert.equal(cronLegDue(now - (MIN - CRON_SLACK_MS) + 1, now, MIN), false);
	assert.equal(cronLegDue(now + 10000, now, MIN), true, 'a stored time in the future');
	assert.equal(cronLegDue(now - 31000, now, 30000), true, 'a site with CRON_INTERVAL_MS 30000');
});

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('index.js: the cron leg is gated on cronLegDue, and its start is stored before the run', () => {
	const run = src.indexOf('async alarmRun() {');
	assert.ok(run >= 0);
	const body = src.slice(run, src.indexOf('\n\tasync fetch(raw) {', run));
	assert.match(body, /const legDue = cronLegDue\(lastCron, Date\.now\(\), Number\(this\.env\.CRON_INTERVAL_MS \|\| 60000\)\);/);
	assert.match(body, /const cronGo = legDue && !importHeld/);
	const go = body.indexOf('if (cronGo) {');
	const stored = body.indexOf('await this.ctx.storage.put(CRON_LAST_KEY, Date.now());', go);
	const boots = body.indexOf('cr = await runCron(', go);
	assert.ok(go >= 0 && stored > go && boots > stored, 'store the start, then run');
	// The purge is not gated: it runs after the cron block, whatever legDue says.
	const purge = body.indexOf('if (st.pending) {');
	assert.ok(purge > boots, 'the purge still runs after the cron block');
	assert.ok(!/legDue/.test(body.slice(purge)), 'the purge does not read legDue');
	assert.match(body, /notDue: !legDue/, 'a not-due skip is visible in /_purgestate cronSkip');
});
