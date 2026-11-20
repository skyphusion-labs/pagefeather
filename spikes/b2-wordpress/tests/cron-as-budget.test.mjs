// node --test spikes/b2-wordpress/tests/cron-as-budget.test.mjs (#1120)
// Approach A's cron ran ONE Action Scheduler action per leg (#323's b-dosql bound), at one leg a minute, so arm 3's
// order burst left 1,897 due order emails, about 31 h to drain. A leg on A now runs due actions until a time budget
// (CRON_AS_BUDGET_MS, default 20 s) or the PHP heap nears the engine's recycle line, up to CRON_AS_ACTIONS (A default
// 50). b-dosql keeps 1 (#323 measured isolate resets at 4 a tick there). PHP asks the Worker before each further action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cronBounds, cronAsBudgetMs, cronMore, DEFAULT_ACTIONS, DEFAULT_ACTIONS_A, AS_BUDGET_MS, AS_HEAP_MARGIN_MIB } from '../cron-bound.mjs';
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('#1120 the A cron leg may run many actions; b-dosql keeps one (#323)', () => {
	assert.equal(DEFAULT_ACTIONS, 1);
	assert.ok(DEFAULT_ACTIONS_A >= 20, 'A default ' + DEFAULT_ACTIONS_A);
	assert.equal(cronBounds({}).actions, 1, 'b-dosql: unchanged');
	assert.equal(cronBounds({}, { approachA: true }).actions, DEFAULT_ACTIONS_A);
	assert.equal(cronBounds({ CRON_AS_ACTIONS: '7' }, { approachA: true }).actions, 7, 'the knob still wins');
	assert.equal(cronBounds({ CRON_AS_ACTIONS: 'x' }, { approachA: true }).actions, DEFAULT_ACTIONS_A, 'a bad value is the default');
});
test('#1120 the budget knob: 1 to 60 s, a bad value is the default', () => {
	assert.equal(cronAsBudgetMs({}), AS_BUDGET_MS);
	assert.equal(AS_BUDGET_MS, 20000);
	assert.equal(cronAsBudgetMs({ CRON_AS_BUDGET_MS: '5000' }), 5000);
	for (const v of ['0', '999', '60001', 'x', '5000; x']) assert.equal(cronAsBudgetMs({ CRON_AS_BUDGET_MS: v }), AS_BUDGET_MS, v);
});
test('#1120 cronMore: the first action always runs; later ones stop at the budget or near the recycle line', () => {
	const base = { startedAt: 1000, budgetMs: 20000, lineMib: 140 };
	assert.equal(cronMore({ ...base, n: 0, now: 999999, heapMib: 200 }), null, 'the first action runs whatever the clock or heap (as before)');
	assert.equal(cronMore({ ...base, n: 5, now: 1000 + 19999, heapMib: 120 }), null);
	assert.equal(cronMore({ ...base, n: 5, now: 1000 + 20000, heapMib: 120 }), 'budget');
	assert.equal(cronMore({ ...base, n: 5, now: 2000, heapMib: 140 - AS_HEAP_MARGIN_MIB }), 'heap');
	assert.equal(cronMore({ ...base, n: 5, now: 2000, heapMib: 140 - AS_HEAP_MARGIN_MIB - 1 }), null);
	assert.equal(cronMore({ ...base, n: 5, now: 2000, heapMib: undefined }), 'heap', 'an unreadable heap stops (fails closed)');
});
test('#1120 the PHP loop asks cronMore before each further action, and the leg reports why it stopped', () => {
	assert.match(src, /if \( \$as_n > 0 \) \{ \$as_more = function_exists\( 'post_message_to_js' \) \? post_message_to_js\( json_encode\( array\( 'cronMore' => \$as_n \) \) \) : 'stop'; if \( '1' !== \$as_more \) \{ \$as_stop = \$as_more; break; \} \}/);
	assert.match(src, /'as_stop' => \$as_stop/);
	assert.match(src, /if \(m\.cronMore !== undefined\) \{ const why = cronMoreGate \? cronMoreGate\(\) : 'stop'; return why \|\| '1'; \}/);
	assert.match(src, /const \{ actions, wpEvents \} = cronBounds\(ENV, \{ approachA: approachACronEnabled\(ENV\) \}\);/);
	assert.match(src, /as_stop: cr\.as_stop/);
});
