// #699 part B: the account purge budget's rules (budget-state.mjs), with no Cloudflare. Workers Cache purges have
// Free limits per ACCOUNT: 5 a minute, a bucket of 25 (code 1134 past it). The budget hands each site a token before
// it sends, so the account stays under the bucket: 4 a minute and a burst of 20, leaving room for other users.
// Run: node --test deploy/purge-budget/tests/budget-state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { RATE_PER_MIN, BURST, PAUSE_MS, STALE_MS, acquire, refused } from '../budget-state.mjs';

const INTERVAL = 60000 / RATE_PER_MIN;

test('the budget sits below the account bucket: 4 a minute, a burst of 20', () => {
	assert.equal(RATE_PER_MIN, 4);
	assert.equal(BURST, 20);
	assert.ok(RATE_PER_MIN < 5 && BURST < 25, 'below Cloudflare\'s 5 a minute and 25');
});

test('a fresh budget grants the burst, then makes the next site wait about one interval', () => {
	let st;
	for (let i = 0; i < BURST; i++) {
		const a = acquire(st, 'site-' + i, 1000);
		assert.equal(a.grant, true, 'grant ' + i);
		st = a.st;
	}
	const late = acquire(st, 'site-late', 1000);
	assert.equal(late.grant, false);
	assert.ok(late.retryAt > 1000 && late.retryAt <= 1000 + INTERVAL + 1000, 'retry about one interval later: ' + (late.retryAt - 1000));
});

test('over 30 minutes of two greedy sites, the account never gets more than the burst plus the rate', () => {
	let st;
	let now = 0;
	const next = { a: 0, b: 0 };
	const grants = [];
	while (now <= 30 * 60000) {
		for (const s of ['a', 'b']) {
			if (now < next[s]) continue;
			const r = acquire(st, s, now);
			st = r.st;
			if (r.grant) { grants.push(now); next[s] = now + 15000; } // a granted site asks again one gap later
			else next[s] = r.retryAt;
		}
		now += 500;
	}
	assert.ok(grants.length <= BURST + RATE_PER_MIN * 30 + 1, 'grants ' + grants.length);
	// After the burst: no 60 s window holds more than the rate (plus one at the edge).
	const steady = grants.slice(BURST);
	for (let i = 0; i < steady.length; i++) {
		const inWin = steady.filter((t) => t >= steady[i] && t < steady[i] + 60000).length;
		assert.ok(inWin <= RATE_PER_MIN + 1, 'a 60 s window holds ' + inWin);
	}
});

test('two busy sites share the tokens fairly in the steady state', () => {
	let st;
	let now = 0;
	const next = { a: 0, b: 0 };
	const got = { a: 0, b: 0 };
	while (now <= 20 * 60000) {
		for (const s of ['a', 'b']) {
			if (now < next[s]) continue;
			const r = acquire(st, s, now);
			st = r.st;
			if (r.grant) { if (now > 6 * 60000) got[s]++; next[s] = now + 15000; }
			else next[s] = r.retryAt;
		}
		now += 500;
	}
	assert.ok(got.a > 10 && got.b > 10, 'both are served: ' + JSON.stringify(got));
	assert.ok(Math.abs(got.a - got.b) <= 2, 'fair: ' + JSON.stringify(got));
});

test('a refusal (another user spent the bucket) pauses every grant for one refill', () => {
	let st = acquire(undefined, 'a', 0).st;
	st = refused(st, 'a', 1000).st;
	const during = acquire(st, 'b', 1000 + PAUSE_MS - 1);
	assert.equal(during.grant, false);
	assert.ok(during.retryAt >= 1000 + PAUSE_MS, 'not before the pause ends');
	assert.equal(PAUSE_MS, 12000, 'one refill of the account bucket (5 a minute: one per 12 s)');
});

test('a site asking twice keeps ONE place in the queue', () => {
	let st;
	for (let i = 0; i < BURST; i++) st = acquire(st, 'x' + i, 0).st; // spend the burst
	st = acquire(st, 'a', 1).st;
	st = acquire(st, 'a', 2).st;
	st = acquire(st, 'b', 3).st;
	assert.deepEqual(st.queue.map((q) => q.site), ['a', 'b']);
});

test('a queued site that stops asking is dropped after STALE_MS, so it cannot block the queue', () => {
	let st;
	for (let i = 0; i < BURST; i++) st = acquire(st, 'x' + i, 0).st;
	st = acquire(st, 'gone', 1).st; // queued first, never asks again
	st = acquire(st, 'b', 2).st;
	let now = 2;
	let r;
	for (;;) {
		now += 1000;
		r = acquire(st, 'b', now);
		st = r.st;
		if (r.grant) break;
		assert.ok(now < STALE_MS + 5 * INTERVAL, 'b is served within the stale bound');
	}
	assert.ok(!st.queue.some((q) => q.site === 'gone'), 'the silent site was dropped');
});

test('a denied answer always names a retry time in the future', () => {
	let st;
	for (let i = 0; i < BURST; i++) st = acquire(st, 'x' + i, 0).st;
	for (let t = 1; t < 5000; t += 997) {
		const r = acquire(st, 'y', t);
		st = r.st;
		if (!r.grant) assert.ok(r.retryAt > t);
	}
});
