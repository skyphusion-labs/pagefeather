// node --test spikes/b2-wordpress/tests/cron-backlog.test.mjs (#1120, the short next alarm)
// #1126 lets a leg on approach A run due actions to a time budget and a heap stop. A leg that stopped with work still due
// then waited the full CRON_INTERVAL_MS (60 s) for the next one. On A's cron object, a leg that stopped for budget or heap,
// or ran out of its pass with other work due (any leg that ran actions), with as_due above 0, now arms the next alarm CRON_BACKLOG_GAP_MS later (default 5 s), and that
// alarm's leg is due by the backlog mark, not the interval. b-dosql keeps the interval (#470: its alarm boots PHP in the
// isolate that serves the admin). Every other gate (the dying-leg back-off, holds, the lock) still applies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cronBacklogNext, cronBacklogDue, cronBacklogGapMs, BACKLOG_GAP_MS, BACKLOG_MAX_LEGS, CRON_SLACK_MS } from '../cron-bound.mjs';
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('#1120 the backlog gap knob: 1 to 60 s, default 5 s, a bad value is the default', () => {
	assert.equal(BACKLOG_GAP_MS, 5000);
	assert.equal(cronBacklogGapMs({}), 5000);
	assert.equal(cronBacklogGapMs({ CRON_BACKLOG_GAP_MS: '2000' }), 2000);
	for (const v of ['0', '999', '60001', 'x']) assert.equal(cronBacklogGapMs({ CRON_BACKLOG_GAP_MS: v }), 5000, v);
});
test('#1120 cronBacklogNext: a soon leg only on A, only with work still due, only after a leg that made progress', () => {
	const base = { approachA: true, asDue: 40, asStop: 'budget', asActions: 12, gapMs: 5000 };
	assert.equal(cronBacklogNext(base), 5000);
	assert.equal(cronBacklogNext({ ...base, asStop: 'heap' }), 5000);
	assert.equal(cronBacklogNext({ ...base, asStop: null, asActions: 50 }), 5000, 'ran its whole cap');
	assert.equal(cronBacklogNext({ ...base, asStop: null, asActions: 6, asDue: 3 }), 5000, 'the email pass ran out with other work due: that runs next leg (measured: it waited 60 s)');
	assert.equal(cronBacklogNext({ ...base, asActions: 0 }), null, 'ran nothing (a stuck claim): the interval, never a spin');
	assert.equal(cronBacklogNext({ ...base, asDue: 0 }), null, 'nothing due');
	assert.equal(cronBacklogNext({ ...base, asDue: null }), null, 'unknown: the interval');
	assert.equal(cronBacklogNext({ ...base, approachA: false }), null, 'b-dosql keeps the interval (#470)');
	assert.equal(cronBacklogNext({ ...base, asStop: 'stop' }), null, 'no bridge: the bound before #1120, no rush');
});
test('#1120 the soon legs are capped: an action that stays due (reschedules itself at now) cannot keep legs every 5 s', () => {
	const base = { approachA: true, asDue: 40, asStop: 'budget', asActions: 12, gapMs: 5000 };
	assert.equal(BACKLOG_MAX_LEGS, 60);
	assert.equal(cronBacklogNext({ ...base, streak: 0 }), 5000);
	assert.equal(cronBacklogNext({ ...base, streak: BACKLOG_MAX_LEGS - 1 }), 5000, 'the 60th soon leg');
	assert.equal(cronBacklogNext({ ...base, streak: BACKLOG_MAX_LEGS }), null, 'past the cap: the interval');
	assert.equal(cronBacklogNext({ ...base, streak: BACKLOG_MAX_LEGS + 5 }), null, 'and it stays capped while work stays due');
	assert.equal(cronBacklogNext({ ...base }), 5000, 'no streak given: 0');
});
test('#1120 cronBacklogDue: the leg is due once the gap has passed since the mark', () => {
	assert.equal(cronBacklogDue(undefined, 10000, 5000), false);
	assert.equal(cronBacklogDue(1000, 1000 + 5000 - CRON_SLACK_MS - 1, 5000), false);
	assert.equal(cronBacklogDue(1000, 1000 + 5000 - CRON_SLACK_MS, 5000), true);
});
test('#1120 the alarm: the leg is due by the interval OR the backlog mark, and a leg that made progress arms the soon alarm', () => {
	assert.match(src, /const legDue = cronLegDue\(lastCron, Date\.now\(\), Number\(this\.env\.CRON_INTERVAL_MS \|\| 60000\)\) \|\| cronBacklogDue\(await this\.ctx\.storage\.get\(CRON_BACKLOG_KEY\), Date\.now\(\), cronBacklogGapMs\(this\.env\)\);/);
	assert.match(src, /const backlogArgs = \{ approachA: approachACronEnabled\(this\.env\), asDue: cr\.as_due, asStop: cr\.as_stop, asActions: cr\.as_actions, gapMs: cronBacklogGapMs\(this\.env\) \};\n\t+const backlogIn = cronBacklogNext\(\{ \.\.\.backlogArgs, streak: backlogStreak \}\);/);
	assert.match(src, /if \(cur === null \|\| cur === undefined \|\| Number\(cur\) > at\) await setAlarmRecorded\(this\.ctx\.storage, at, Date\.now\(\), 'as-backlog'\);/);
	assert.match(src, /const backlogStreak = Number\(await this\.ctx\.storage\.get\(CRON_BACKLOG_STREAK_KEY\)\) \|\| 0;/);
	assert.match(src, /await this\.ctx\.storage\.put\(CRON_BACKLOG_STREAK_KEY, backlogStreak \+ 1\);/, 'each soon leg counts');
	assert.match(src, /if \(cronBacklogNext\(\{ \.\.\.backlogArgs, streak: 0 \}\)\) console\.log\(JSON\.stringify\(\{ m: 'cron', backlogCapped: backlogStreak/, 'a capped streak is logged and kept');
	assert.match(src, /else await this\.ctx\.storage\.delete\(CRON_BACKLOG_STREAK_KEY\);/, 'the streak resets only when nothing is due or no progress');
	assert.match(src, /await this\.ctx\.storage\.put\(CRON_LAST_KEY, Date\.now\(\)\);\n\t+await this\.ctx\.storage\.delete\(CRON_BACKLOG_KEY\);/, 'the mark is consumed when a leg starts');
});
