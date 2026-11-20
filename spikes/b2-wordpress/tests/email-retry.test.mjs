// node --test spikes/b2-wordpress/tests/email-retry.test.mjs (#1057, the lead's ruling). A rejected wp_mail send was
// logged and dropped. Now: it goes into the durable store (the PHP object's storage) with an attempt count and a
// next-try time, backoff 1, 5, 30 minutes then hourly, capped, then dead-lettered (kept, an email-dead event, counted
// for Site Health). The alarm drain respects next-try, and a message is never sent twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETRY_PREFIX, DEAD_PREFIX, BACKOFF_MS, MAX_ATTEMPTS, failureRecords, drainRetries, retryKey } from '../email-retry.mjs';

const MIN = 60_000;
test('the backoff is 1, 5, 30 minutes, then hourly; the cap is 7 attempts in all (the first send and 6 retries)', () => {
	assert.deepEqual(BACKOFF_MS, [1 * MIN, 5 * MIN, 30 * MIN, 60 * MIN, 60 * MIN, 60 * MIN]);
	assert.equal(MAX_ATTEMPTS, 7);
});

test('a rejected send becomes ONE record per failed recipient, due after the first backoff; the address is never in the key', () => {
	const now = 1_000_000;
	const email = { to: ['a@x.test', 'b@x.test'], subject: 'Your order', message: 'hi', headers: '', as_action: 12 };
	const recs = failureRecords([{ email, to: 'b@x.test', error: 'rate limited' }], now);
	assert.equal(recs.length, 1);
	const [key, rec] = recs[0];
	assert.ok(key.startsWith(RETRY_PREFIX));
	assert.doesNotMatch(key, /x\.test/, 'no address in the storage key');
	assert.deepEqual(rec.email.to, ['b@x.test'], 'only the recipient that failed is retried');
	assert.equal(rec.attempts, 1);
	assert.equal(rec.next, now + 1 * MIN);
	assert.equal(retryKey(email, 'b@x.test'), key, 'the same failure maps to the same key (a second failure report does not add a copy)');
});

// A fake store and sender.
function store(entries = []) {
	const m = new Map(entries);
	return {
		m,
		async list({ prefix }) { return new Map([...m].filter(([k]) => k.startsWith(prefix))); },
		async put(k, v) { m.set(k, structuredClone(v)); },
		async delete(k) { m.delete(k); },
	};
}

test('a retry is not sent before its next-try time', async () => {
	const now = 1_000_000;
	const [[k, r]] = failureRecords([{ email: { to: ['a@x.test'], subject: 's' }, to: 'a@x.test', error: 'e' }], now);
	const s = store([[k, r]]);
	const sent = [];
	const out = await drainRetries({ storage: s, now: now + 30_000, send: async (e) => sent.push(e), log: () => {} });
	assert.deepEqual(sent, []);
	assert.equal(out.next, now + MIN, 'the drain says when the next one is due (for the alarm)');
});

test('a rejected send is retried after its backoff and sent ONCE on success: the record goes, a second drain sends nothing', async () => {
	const now = 1_000_000;
	const [[k, r]] = failureRecords([{ email: { to: ['a@x.test'], subject: 's' }, to: 'a@x.test', error: 'e' }], now);
	const s = store([[k, r]]);
	const sent = [];
	const send = async (e) => { sent.push(e.to[0]); };
	const o1 = await drainRetries({ storage: s, now: now + MIN, send, log: () => {} });
	assert.deepEqual(sent, ['a@x.test']);
	assert.equal(o1.sent, 1);
	assert.equal(s.m.size, 0, 'the record is gone');
	await drainRetries({ storage: s, now: now + 10 * MIN, send, log: () => {} });
	assert.deepEqual(sent, ['a@x.test'], 'never sent twice');
});

test('the claim is written BEFORE the send: a send that hangs or dies leaves the record pushed to its next backoff, not due again at once', async () => {
	const now = 1_000_000;
	const [[k, r]] = failureRecords([{ email: { to: ['a@x.test'], subject: 's' }, to: 'a@x.test', error: 'e' }], now);
	const s = store([[k, r]]);
	let seenDuringSend = null;
	await drainRetries({ storage: s, now: now + MIN, send: async () => { seenDuringSend = structuredClone(s.m.get(k)); throw new Error('again'); }, log: () => {} });
	assert.equal(seenDuringSend.attempts, 2, 'attempt counted before the send');
	assert.equal(seenDuringSend.next, now + MIN + 5 * MIN, 'and the next try pushed before the send');
});

test('a send that keeps failing stops at the cap and is dead-lettered: kept, one email-dead event, no address in it', async () => {
	let now = 1_000_000;
	const [[k, r]] = failureRecords([{ email: { to: ['a@x.test'], subject: 'Password reset' }, to: 'a@x.test', error: 'e' }], now);
	const s = store([[k, r]]);
	const events = [];
	let tries = 0;
	for (let i = 0; i < 20; i++) {
		const rec = s.m.get(k);
		if (!rec) break;
		now = rec.next;
		await drainRetries({ storage: s, now, send: async () => { tries++; throw new Error('rejected'); }, log: (e) => events.push(e) });
	}
	assert.equal(tries, MAX_ATTEMPTS - 1, '6 retries after the first send');
	assert.equal([...s.m.keys()].filter((x) => x.startsWith(RETRY_PREFIX)).length, 0);
	const dead = [...s.m.entries()].filter(([x]) => x.startsWith(DEAD_PREFIX));
	assert.equal(dead.length, 1, 'kept as dead');
	assert.equal(dead[0][1].attempts, MAX_ATTEMPTS);
	const ev = events.filter((e) => e.m === 'email-dead');
	assert.equal(ev.length, 1);
	assert.equal(ev[0]['@event'], 'email-dead');
	assert.doesNotMatch(JSON.stringify(ev[0]), /x\.test/, 'no address in the event');
});

test('one bad record does not stop the others; a malformed record is dead-lettered, never retried forever', async () => {
	const now = 1_000_000;
	const recs = failureRecords([{ email: { to: ['a@x.test'], subject: 's' }, to: 'a@x.test', error: 'e' }, { email: { to: ['b@x.test'], subject: 's' }, to: 'b@x.test', error: 'e' }], now);
	const s = store([...recs, [RETRY_PREFIX + 'junk', { nope: true }]]);
	const sent = [];
	const events = [];
	await drainRetries({ storage: s, now: now + MIN, send: async (e) => { if (e.to[0] === 'a@x.test') throw new Error('x'); sent.push(e.to[0]); }, log: (e) => events.push(e) });
	assert.deepEqual(sent, ['b@x.test']);
	assert.ok(s.m.has(DEAD_PREFIX + 'junk'));
	assert.ok(events.some((e) => e.m === 'email-dead' && e.reason === 'malformed'));
});

// The lead's review on #1062 (privacy is the primary goal): a dead letter must not keep the message. Only metadata:
// deadAt, attempts, the last error (capped, addresses and URLs scrubbed), a hash of the subject, the recipient's
// domain. No body, no address, no reset link. Dead records expire after 30 days. A live retry keeps the message only
// within the retry window.
import { DEAD_TTL_MS, RETRY_WINDOW_MS, scrub } from '../email-retry.mjs';
const RESET = { to: ['alice@shop.example.org'], subject: 'Password Reset for alice', message: 'Reset: https://shop.example.org/wp-login.php?action=rp&key=SECRETKEY123&login=alice', headers: '' };
async function deadAfterCap(email) {
	let now = 1_000_000;
	const [[k, r]] = failureRecords([{ email, to: email.to[0], error: 'rejected for alice@shop.example.org at https://x.test/?key=SECRETKEY123' }], now);
	const s = store([[k, r]]);
	const events = [];
	for (let i = 0; i < 20; i++) {
		const rec = s.m.get(k);
		if (!rec) break;
		now = rec.next;
		await drainRetries({ storage: s, now, send: async () => { throw new Error('refused for alice@shop.example.org https://shop.example.org/?key=SECRETKEY123'); }, log: (e) => events.push(e) });
	}
	return { s, events, now };
}
test('#1062 review: a dead-lettered reset email leaves NO body, address or reset key in storage or in the event', async () => {
	const { s, events } = await deadAfterCap(RESET);
	const dump = JSON.stringify([...s.m.entries()]) + JSON.stringify(events);
	for (const secret of ['SECRETKEY123', 'alice@shop.example.org', 'wp-login.php', 'Reset:', 'Password Reset for alice']) {
		assert.ok(!dump.includes(secret), 'not kept: ' + secret);
	}
	const [, dead] = [...s.m.entries()].find(([x]) => x.startsWith(DEAD_PREFIX));
	assert.deepEqual(Object.keys(dead).sort(), ['attempts', 'deadAt', 'domain', 'expiresAt', 'firstAt', 'lastError', 'reason', 'subjectHash'].sort());
	assert.equal(dead.domain, 'shop.example.org', 'the recipient domain at most');
	assert.match(dead.subjectHash, /^[0-9a-f]{16}$/);
	assert.equal(dead.expiresAt, dead.deadAt + DEAD_TTL_MS);
});
test('#1062 review: dead records expire after 30 days (the drain prunes them); the count sees only live dead letters', async () => {
	assert.equal(DEAD_TTL_MS, 30 * 24 * 60 * 60 * 1000);
	const { s, now } = await deadAfterCap(RESET);
	assert.equal([...s.m.keys()].filter((x) => x.startsWith(DEAD_PREFIX)).length, 1);
	await drainRetries({ storage: s, now: now + DEAD_TTL_MS - 1000, send: async () => {}, log: () => {} });
	assert.equal([...s.m.keys()].filter((x) => x.startsWith(DEAD_PREFIX)).length, 1, 'kept until its expiry');
	const out = await drainRetries({ storage: s, now: now + DEAD_TTL_MS + 1000, send: async () => {}, log: () => {} });
	assert.equal([...s.m.keys()].filter((x) => x.startsWith(DEAD_PREFIX)).length, 0, 'gone after it');
	assert.equal(out.expired, 1);
});
test('#1062 review: a LIVE retry keeps the message only within the retry window; past it, it is dead-lettered (metadata only)', async () => {
	const now = 1_000_000;
	const [[k, r]] = failureRecords([{ email: RESET, to: RESET.to[0], error: 'e' }], now);
	const s = store([[k, { ...r, next: now + RETRY_WINDOW_MS + 5000 }]]); // the drain did not run in time
	await drainRetries({ storage: s, now: now + RETRY_WINDOW_MS + 1000, send: async () => {}, log: () => {} });
	assert.ok(!s.m.has(k), 'the live record with the message is gone');
	assert.ok(!JSON.stringify([...s.m.entries()]).includes('SECRETKEY123'));
	assert.equal([...s.m.values()][0].reason, 'window');
	assert.ok(RETRY_WINDOW_MS >= 216 * 60_000, 'at least the whole backoff (1+5+30+60+60+60 minutes)');
});
test('#1062 review: scrub removes addresses and URLs from an error', () => {
	assert.equal(scrub('to a.b@c.org via https://x.y/z?key=1 failed'), 'to [address] via [url] failed');
});
