// #699 part B: the account purge budget's rules (budget-state.mjs), with no Cloudflare. Workers Cache purges have
// Free limits per ACCOUNT: 5 a minute, a bucket of 25 (code 1134 past it). The budget hands each site a token before
// it sends, so the account stays under the bucket: 4 a minute and a burst of 20, leaving room for other users.
// Run: node --test deploy/purge-budget/tests/budget-state.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { RATE_PER_MIN, BURST, ACCOUNT_REFILL_MS, STALE_MS, acquire, refused } from '../budget-state.mjs';

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

// The property of a token bucket: in ANY window of length w, at most burst + rate x w grants. A stream that keeps it
// for (20, 4 a minute) also keeps it for Cloudflare's larger bucket (25, 5 a minute), so no grant is refused for rate.
function conforms(grants, burst, perMin) {
	for (let i = 0; i < grants.length; i++)
		for (let j = i; j < grants.length; j++) {
			const n = j - i + 1;
			const allowed = burst + (perMin * (grants[j] - grants[i])) / 60000;
			if (n > allowed + 1e-9) return 'grants ' + i + ' to ' + j + ': ' + n + ' in ' + (grants[j] - grants[i]) + ' ms';
		}
	return null;
}

test('over 30 minutes of two greedy sites, the grants conform to the budget AND to the account bucket', () => {
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
	assert.equal(conforms(grants, BURST, RATE_PER_MIN), null, 'the budget (20, 4 a minute)');
	assert.equal(conforms(grants, 25, 5), null, 'Cloudflare\'s account bucket (25, 5 a minute)');
	assert.ok(grants.length >= BURST + RATE_PER_MIN * 30 - 2, 'and it is used: ' + grants.length + ' grants');
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

test('a refusal (another user spent the bucket) empties the budget: no grant for at least one account refill', () => {
	let st = acquire(undefined, 'a', 0).st; // 19 tokens left
	st = refused(st, 'a', 1000).st;
	const during = acquire(st, 'b', 1000 + ACCOUNT_REFILL_MS - 1);
	assert.equal(during.grant, false, 'no grant before one refill, although the budget held 19 tokens');
	assert.ok(during.retryAt >= 1000 + ACCOUNT_REFILL_MS, 'the retry is not before the refill');
	assert.equal(ACCOUNT_REFILL_MS, 12000, 'one refill of the account bucket (5 a minute: one per 12 s)');
});

test('after a long idle spell, the burst is still at most BURST (tokens never pile up)', () => {
	let st = acquire(undefined, 'warm', 0).st;
	const later = 3600000; // an hour of nothing
	let granted = 0;
	for (let i = 0; i < 40; i++) {
		const r = acquire(st, 's' + i, later);
		st = r.st;
		if (r.grant) granted++;
	}
	assert.equal(granted, BURST);
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
	// It is dropped once it has been silent for STALE_MS (the next acquire cleans the queue).
	st = acquire(st, 'c', 1 + STALE_MS + 1).st;
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
