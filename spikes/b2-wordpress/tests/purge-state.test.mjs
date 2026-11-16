// #699: the site's purge rules (purge-state.mjs), with no Cloudflare. A refused purge (Free limits: 5 a minute per
// account, code 1134) must stay pending and be retried with a back-off, never dropped, until no cached copy it
// targets can still be served: PAGE_CACHE_TTL + stale-while-revalidate (720 s by default). Then it expires, counted.
// Run: node --test spikes/b2-wordpress/tests/purge-state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { PURGE_GAP_MS, RETRY_MS, NO_CACHE_API, purgeWindowMs, onAsk, onDue, onResult } from '../purge-state.mjs';

const REFUSED = { ok: false, errors: [{ code: 1134, message: 'Unable to purge, rate limit reached.' }] };
const OK = { ok: true, errors: [] };
const LOCAL = { ok: false, errors: [], error: NO_CACHE_API };
// A purge that threw: index.js catches it as errors only, no error field.
const THREW = { ok: false, errors: ['TypeError: network connection lost'] };

// Drive one send: due, then the result. Returns the state and the next alarm.
function send(st, now, r, windowMs = 720000) {
	const d = onDue(st, now, windowMs);
	assert.equal(d.action, 'send', 'the purge is due');
	return onResult(d.st, now, r, d.covered);
}

test('the purge window is PAGE_CACHE_TTL plus stale-while-revalidate', () => {
	assert.equal(purgeWindowMs({}), (120 + 600) * 1000, 'unset: 120 + 600 s');
	assert.equal(purgeWindowMs({ PAGE_CACHE_TTL: '60' }), (60 + 600) * 1000);
	assert.equal(purgeWindowMs({ PAGE_CACHE_TTL: '0' }), 0, 'the page cache off: nothing is cached, nothing to purge');
});

test('an ask on an idle site schedules one send, after the gap', () => {
	const a = onAsk({ lastSent: 1000 }, 2000);
	assert.equal(a.coalesced, false);
	assert.equal(a.st.pending, true);
	assert.equal(a.st.firstAsked, 2000);
	assert.equal(a.alarmAt, 1000 + PURGE_GAP_MS);
});

test('an ask while a purge is pending coalesces: no new alarm, the oldest change is kept', () => {
	const a = onAsk({ lastSent: 0 }, 5000);
	const b = onAsk(a.st, 9000);
	assert.equal(b.coalesced, true);
	assert.equal(b.alarmAt, null);
	assert.equal(b.st.firstAsked, 5000);
});

test('a sent purge that succeeds clears the attempts', () => {
	const a = onAsk({ lastSent: 0 }, 1000);
	const r = send(a.st, 16000, OK);
	assert.equal(r.outcome, 'ok');
	assert.equal(r.st.pending, false);
	assert.equal(r.st.attempts, 0);
	assert.equal(r.alarmAt, null);
});

test('a refused purge stays pending and is retried with a back-off (12, 24, 48 s, then 48 s)', () => {
	let st = onAsk({ lastSent: 0 }, 1000).st;
	let now = 16000;
	const waits = [];
	for (let i = 0; i < 5; i++) {
		const r = send(st, now, REFUSED);
		assert.equal(r.outcome, 'refused');
		assert.equal(r.st.pending, true, 'refusal ' + (i + 1) + ': still pending');
		assert.equal(r.st.firstAsked, 1000, 'the oldest change is kept across retries');
		assert.equal(r.st.lastCode, 1134);
		waits.push(r.alarmAt - now);
		st = r.st;
		now = r.alarmAt;
	}
	assert.deepEqual(waits, [RETRY_MS[0], RETRY_MS[1], RETRY_MS[2], RETRY_MS[2], RETRY_MS[2]]);
	assert.deepEqual(RETRY_MS, [12000, 24000, 48000]);
});

test('refused twice: NOT dropped (today it is: one retry, then pending is false)', () => {
	let st = onAsk({ lastSent: 0 }, 1000).st;
	const r1 = send(st, 16000, REFUSED);
	const r2 = send(r1.st, r1.alarmAt, REFUSED);
	assert.equal(r2.st.pending, true);
	assert.notEqual(r2.alarmAt, null, 'a retry is scheduled');
});

test('a change made while a purge was in flight is covered by the retry', () => {
	const st = onAsk({ lastSent: 0 }, 1000).st;
	const d = onDue(st, 16000, 720000);
	const during = onAsk(d.st, 16500); // a change while the purge is out
	const r = onResult(during.st, 17000, REFUSED, d.covered);
	assert.equal(r.st.pending, true);
	assert.equal(r.st.firstAsked, 1000, 'the retry covers the older change too');
});

test('a purge older than the window expires, counted, and is not sent', () => {
	let st = onAsk({ lastSent: 0 }, 1000).st;
	const d = onDue(st, 1000 + 720000 + 1, 720000);
	assert.equal(d.action, 'expire');
	assert.equal(d.st.pending, false);
	assert.equal(d.st.expired, 1);
	assert.equal(d.st.attempts, 0);
});

test('a refused purge keeps retrying up to the window, then expires', () => {
	let st = onAsk({ lastSent: 0 }, 0).st;
	let now = PURGE_GAP_MS;
	let sends = 0;
	for (;;) {
		const d = onDue(st, now, 720000);
		if (d.action === 'expire') {
			st = d.st;
			break;
		}
		assert.equal(d.action, 'send');
		const r = onResult(d.st, now, REFUSED, d.covered);
		sends++;
		st = r.st;
		now = r.alarmAt;
		assert.ok(sends < 100, 'bounded');
	}
	assert.equal(st.expired, 1);
	assert.ok(sends >= 10, 'it kept trying for the whole window: ' + sends + ' sends');
	assert.ok(now > 720000, 'and stopped only after the window');
});

test('no cache API on this runtime (r.error is the marker): DROPPED on purpose, nothing can ever purge there', () => {
	const st = onAsk({ lastSent: 0 }, 1000).st;
	const r = send(st, 16000, LOCAL);
	assert.equal(r.outcome, 'unavailable');
	assert.equal(r.st.pending, false);
	assert.equal(r.alarmAt, null);
});

test('a purge that THREW (errors, no error field) is kept and retried, not dropped', () => {
	const st = onAsk({ lastSent: 0 }, 1000).st;
	const r = send(st, 16000, THREW);
	assert.equal(r.outcome, 'refused');
	assert.equal(r.st.pending, true);
	assert.equal(r.alarmAt, 16000 + RETRY_MS[0]);
});

test('any other error value is kept and retried: only the exact no-cache marker drops', () => {
	const st = onAsk({ lastSent: 0 }, 1000).st;
	const r = send(st, 16000, { ok: false, errors: [], error: 'something else went wrong' });
	assert.equal(r.st.pending, true);
	assert.notEqual(r.alarmAt, null);
});

test('the page cache off (window 0): a pending purge expires at once, never sent', () => {
	const st = onAsk({ lastSent: 0 }, 1000).st;
	const d = onDue(st, 1001, purgeWindowMs({ PAGE_CACHE_TTL: '0' }));
	assert.equal(d.action, 'expire');
});

test('nothing pending: nothing to do', () => {
	assert.equal(onDue({ pending: false }, 1000, 720000).action, 'none');
});
