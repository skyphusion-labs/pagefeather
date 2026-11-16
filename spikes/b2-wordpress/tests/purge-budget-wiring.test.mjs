// #699 part B: the PHP object's alarm asks the account purge budget BEFORE it purges, and a "not now" keeps the purge
// pending: no state is stored, no purge is sent, the alarm moves to the budget's time. The object itself cannot run in
// node, so this reads index.js (as rpc-dispose.test.mjs does). The client's rules are purge-budget-client.test.mjs.
// Run: node --test spikes/b2-wordpress/tests/purge-budget-wiring.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const start = src.indexOf('const due = onDue(');
const end = src.indexOf('// Keep the cron cadence unless the purge logic set a sooner retry alarm.', start);
const body = src.slice(start, end);

test('the purge step is found', () => {
	assert.ok(start > 0 && end > start, 'the alarm purge step and its end marker');
});

test('the budget is asked before the purge is sent, only for a send', () => {
	const ask = body.indexOf('await budgetAcquire(this.env, budgetSite)');
	const purge = body.indexOf("this.ctx.exports.Pages.purge(['wp-pages'])");
	assert.ok(ask > 0 && purge > ask, 'budgetAcquire comes before Pages.purge');
	assert.match(body, /const gate = due\.action === 'send' \? await budgetAcquire/);
});

test('"not now" stores nothing and sends nothing: the purge stays pending', () => {
	const deny = body.indexOf("if (gate && gate.via === 'budget' && !gate.grant) {");
	const next = body.indexOf("} else if (due.action === 'expire') {", deny);
	assert.ok(deny > 0 && next > deny, 'the deny branch');
	const branch = body.slice(deny, next);
	assert.ok(!/storage\.put\(PURGE_STATE_KEY/.test(branch), 'no state stored in the deny branch');
	assert.ok(!/Pages\.purge/.test(branch), 'no purge in the deny branch');
	assert.match(branch, /setAlarmRecorded\(this\.ctx\.storage, gate\.retryAt,/, 'the alarm moves to the budget\'s time');
});

test('a refusal under a budget grant tells the budget', () => {
	assert.match(body, /if \(res\.outcome === 'refused' && gate && gate\.via === 'budget'\) await budgetRefused\(this\.env, budgetSite\);/);
});

test('the budget lines are not m: purge lines (doctor\'s #688 guard counts those as asked or sent)', () => {
	assert.match(body, /m: 'purge-budget'/);
});
