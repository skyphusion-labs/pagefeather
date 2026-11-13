// A request whose writes were lost to an isolate memory reset sends NO mail (#368, the lead's ruling:
// HOLD). Before: the request handed its collected mail to sendPending BEFORE it counted the lost
// writes and answered the #353 500, so a mail could confirm a change that was not saved, and a client
// retry sent a second one. Now the request counts first; with a loss every collected mail is held,
// and each held mail is one structured `email-held` event, so a hold is never silent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { heldRequestMail } from '../write-loss.mjs';

const mails = [{ to: ['a@example.com'], subject: 'Password Reset Request', as_action: 0 }, { to: ['b@example.com'], subject: 'Welcome to the store, a very long subject line that goes on and on and on past eighty chars' }];
test('THE #368 CASE: a request with lost writes holds every collected mail, one event each', () => {
	const r = heldRequestMail(mails, 3, { method: 'POST', path: '/wp-login.php' });
	assert.equal(r.send.length, 0);
	assert.equal(r.events.length, 2);
	for (const e of r.events) {
		assert.equal(e['@event'], 'email-held');
		assert.equal(e.where, 'request');
		assert.equal(e.lostWrites, 3);
		assert.equal(e.path, '/wp-login.php');
		assert.ok(e.subject.length <= 80);
	}
	assert.equal(r.events[0].subject, 'Password Reset Request');
});
test('a request with no lost write sends every collected mail, and logs no hold', () => {
	const r = heldRequestMail(mails, 0, { method: 'POST', path: '/x' });
	assert.equal(r.send.length, 2);
	assert.equal(r.events.length, 0);
});
test('no mail: nothing to send or hold', () => {
	const r = heldRequestMail([], 5, {});
	assert.deepEqual(r, { send: [], events: [] });
});
test('a held event carries no recipient address (Workers Logs is not a mail log)', () => {
	const r = heldRequestMail(mails, 1, {});
	assert.ok(!JSON.stringify(r.events).includes('@example.com'));
	assert.equal(r.events[0].recipients, 1);
});

// The wiring in index.js: the drain decides AFTER the request counted its lost writes.
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
test('index.js: the request counts its lost writes before it hands any mail to sendPending', () => {
	const lostAt = src.indexOf('const lost = resetFailures(d.failures);');
	const planAt = src.indexOf('heldRequestMail(pendingEmails, lost,');
	assert.ok(lostAt > 0, 'the lost-write count is in index.js');
	assert.ok(planAt > lostAt, 'the mail decision comes after the count');
	const between = src.slice(lostAt - 1200, lostAt);
	assert.ok(!between.includes('const sp = sendPending(env);'), 'no send before the count');
});
test('index.js: each held request mail is logged', () => {
	assert.ok(src.includes('for (const e of plan.events) console.log(JSON.stringify(e));'));
});
