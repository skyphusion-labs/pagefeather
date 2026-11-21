// node --test spikes/b2-wordpress/tests/remote-packs.test.mjs (#563). The held-pack budget of
// remote-packs.mjs with synthetic packs: a cold boot STREAMS through the packs (at most the budget
// held, least recently used out first, the pack being opened always kept), an evicted pack is
// fetched again when one of its files is opened again, nothing is held across requests, and the
// request's high-water of held bytes is reported (x-perf rfHeldKiB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRemotePacks, createFetchBudget, REMOTE_HOLD_BYTES, REMOTE_FETCH_CAP, SITE_FETCH_CAP, SITE_HOLD_BYTES } from '../remote-packs.mjs';

// Three packs of 1000 bytes; file fN lives in pack N. parse() gives each pack one entry.
const bytes = [0, 1, 2].map((n) => new Uint8Array(1000).fill(n + 1));
const index = {
	id: 't',
	packs: bytes.map((b, n) => ({ name: 'oc-' + n + '.zip', bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') })),
	files: { f0: [0, 4], f1: [1, 4], f2: [2, 4] },
};
const parse = (b) => [{ name: 'f' + (b[0] - 1), data: () => b.subarray(0, 4) }];
function make(holdBytes, cap) {
	const fetched = [];
	const stats = {};
	const r = createRemotePacks({ index, parse, stats, cap, holdBytes, fetchPack: async (name) => { fetched.push(name); return bytes[Number(name.slice(3, 4))].slice(); } });
	return { r, fetched, stats };
}
const open = async (r, f) => { const p = r.open(f); if (p) await p; };

test('a cold boot streams: with a 2-pack budget, the third pack evicts the first', async () => {
	const { r, fetched, stats } = make(2000);
	await open(r, 'f0');
	await open(r, 'f1');
	assert.equal(r.heldPacks(), 2);
	await open(r, 'f2');
	assert.equal(r.heldPacks(), 2, 'never more than the budget');
	assert.equal(r.data('f0'), null, 'f0 was evicted: its bytes are gone (a read now fails with EIO)');
	assert.ok(r.data('f2'), 'the pack just opened is held');
	assert.deepEqual(fetched, ['oc-0.zip', 'oc-1.zip', 'oc-2.zip']);
	assert.equal(stats.rfN, 3);
});

test('an evicted pack is fetched again when its file is opened again (and counted)', async () => {
	const { r, fetched, stats } = make(2000);
	for (const f of ['f0', 'f1', 'f2', 'f0']) await open(r, f);
	assert.deepEqual(fetched, ['oc-0.zip', 'oc-1.zip', 'oc-2.zip', 'oc-0.zip']);
	assert.equal(stats.rfN, 4);
	assert.ok(r.data('f0'));
});

test('a held pack is used again without a fetch, and is the most recent after', async () => {
	const { r, fetched } = make(2000);
	for (const f of ['f0', 'f1', 'f0', 'f2']) await open(r, f);
	assert.deepEqual(fetched, ['oc-0.zip', 'oc-1.zip', 'oc-2.zip'], 'f0 reopened while held: no fetch');
	assert.ok(r.data('f0'), 'f0 was touched last before f2, so f1 was the one evicted');
	assert.equal(r.data('f1'), null);
});

test('the pack being opened is kept even when it alone is over the budget', async () => {
	const { r } = make(1);
	await open(r, 'f0');
	assert.ok(r.data('f0'));
	assert.equal(r.heldPacks(), 1);
	await open(r, 'f1');
	assert.equal(r.heldPacks(), 1);
	assert.ok(r.data('f1'));
});

test('nothing is held across requests, and the request high-water is reported', async () => {
	const { r } = make(2000);
	await open(r, 'f0');
	await open(r, 'f1');
	await open(r, 'f2');
	r.endRequest();
	assert.equal(r.heldPacks(), 0);
	assert.equal(r.lastHeldMax(), 2000, 'the high-water of the request just ended');
	await open(r, 'f2');
	r.endRequest();
	assert.equal(r.lastHeldMax(), 1000, 'a new request starts from 0');
});

test('the per-request cap counts refetches too, and resets with the request', async () => {
	const { r, stats } = make(1000, 2);
	await open(r, 'f0');
	await open(r, 'f1');
	await assert.rejects(r.open('f2'), /cap 2/);
	assert.equal(stats.rfCapped, 1);
	r.endRequest();
	await open(r, 'f2');
	assert.equal(stats.rfN, 3);
});

test('distinct packs per request tell thrash from spread (x-perf rfPacks)', async () => {
	const { r, stats } = make(2000);
	for (const f of ['f0', 'f1', 'f2', 'f0']) await open(r, f);
	r.endRequest();
	assert.equal(stats.rfN, 4, 'four fetches');
	assert.equal(r.lastDistinct(), 3, 'of three distinct packs: one refetch, the thrash');
	await open(r, 'f1');
	r.endRequest();
	assert.equal(r.lastDistinct(), 1, 'a new request counts from 0');
});

test('the defaults are the measured choice: 4 MiB held (3 packs of about 1.1 MiB), cap 64', () => {
	// opcache-build run 43603733149: 2 MiB held ONE pack and thrashed (86 fetches over 4 pages);
	// 4 MiB held three (39 fetches, 20 on the cold boot, peak 3,270 KiB). The lead chose 4 MiB.
	assert.equal(REMOTE_HOLD_BYTES, 4096 * 1024);
	assert.equal(REMOTE_FETCH_CAP, 64);
});

// #569 (Gate 2): site packs, a budget shared with OPcache, one retry, and a hot pack.
const hotBytes = new Uint8Array(500).fill(9);
const sidx = {
	id: 's',
	hot: { name: 'site-hot.zip', bytes: hotBytes.length, sha256: createHash('sha256').update(hotBytes).digest('hex') },
	packs: index.packs.map((p, n) => ({ ...p, name: 'st-' + n + '.zip' })),
	files: { f0: [0, 4], f1: [1, 4], f2: [2, 4], h: [-1, 4] },
};
const sparse = (b) => (b[0] === 9 ? [{ name: 'h', data: () => b.subarray(0, 4) }] : parse(b));
function site({ budget, retries = 1, failFirst = 0, holdBytes = 2000 } = {}) {
	const fetched = [];
	const waits = [];
	const stats = {};
	let fails = failFirst;
	const r = createRemotePacks({
		index: sidx, parse: sparse, stats, prefix: 'rs', budget, limit: 'hard', retries, retryDelayMs: 25,
		sleep: async (ms) => { waits.push(ms); }, holdBytes,
		fetchPack: async (name) => {
			fetched.push(name);
			if (fails > 0) { fails--; throw new Error(name + ' answered 503'); }
			return name === 'site-hot.zip' ? hotBytes.slice() : bytes[Number(name.slice(3, 4))].slice();
		},
	});
	return { r, fetched, waits, stats };
}

test('#569 the site counters have their own prefix, rs*, and leave rf* alone', async () => {
	const { r, stats } = site();
	await open(r, 'f0');
	assert.equal(stats.rsN, 1);
	assert.equal(stats.rfN, undefined);
});

test('#569 one retry of a failed site pack, after the fixed delay, and it is counted', async () => {
	const { r, fetched, waits, stats } = site({ failFirst: 1 });
	await open(r, 'f1');
	assert.deepEqual(fetched, ['st-1.zip', 'st-1.zip']);
	assert.deepEqual(waits, [25]);
	assert.equal(stats.rsRetry, 1);
	assert.equal(stats.rsFail, 0);
	assert.equal(stats.rsN, 2, 'the retry is a fetch, and a subrequest');
	assert.ok(r.data('f1'));
});

test('#569 a second failure fails the open: ONE retry only, counted as a failure', async () => {
	const { r, fetched, stats } = site({ failFirst: 2 });
	await assert.rejects(r.open('f1'), /503/);
	assert.equal(fetched.length, 2);
	assert.equal(stats.rsRetry, 1);
	assert.equal(stats.rsFail, 1);
});

test('#569 the budget is shared: OPcache stops at the soft cap, site may go on to the hard cap', async () => {
	const budget = createFetchBudget({ soft: 2, hard: 3 });
	const ostats = {};
	const opc = createRemotePacks({ index, parse, stats: ostats, budget, limit: 'soft', holdBytes: 1, fetchPack: async (name) => bytes[Number(name.slice(3, 4))].slice() });
	await open(opc, 'f0');
	await open(opc, 'f1');
	await assert.rejects(opc.open('f2'), /cap/);
	assert.equal(ostats.rfCapped, 1, 'OPcache refused at the soft cap (a compile)');
	const s = site({ budget });
	await open(s.r, 'f0');
	assert.equal(s.stats.rsN, 1, 'site took the third, under the hard cap');
	await assert.rejects(s.r.open('f1'), /cap/);
	assert.equal(s.stats.rsCapped, 1);
	budget.reset();
	await open(opc, 'f2');
	assert.equal(ostats.rfN, 3, 'a new request starts from 0');
});

test('#569 a retry needs budget too: at the hard cap the retry is refused and the open fails', async () => {
	const budget = createFetchBudget({ soft: 1, hard: 1 });
	const { r, fetched, stats } = site({ budget, failFirst: 1 });
	await assert.rejects(r.open('f0'));
	assert.equal(fetched.length, 1, 'no second fetch past the cap');
	assert.equal(stats.rsCapped, 1);
});

test('#569 the hot pack is fetched once per runtime and held across requests, outside the LRU', async () => {
	const { r, fetched } = site({ holdBytes: 1 });
	await open(r, 'h');
	await open(r, 'f0');
	await open(r, 'f1');
	assert.ok(r.data('h'), 'the hot file is still held: the LRU never evicts the hot pack');
	r.endRequest();
	await open(r, 'h');
	assert.ok(r.data('h'));
	assert.deepEqual(fetched.filter((n) => n === 'site-hot.zip'), ['site-hot.zip'], 'fetched ONCE');
	assert.equal(r.heldPacks(), 0, 'the request packs are gone; the hot pack is not counted among them');
});

test('#569 the defaults: site hard cap 96, site held budget 8 MiB (the lead\'s choice on pf570m)', () => {
	assert.equal(SITE_FETCH_CAP, 96);
	// 2048 thrashed a compile boot (87 fetches, the checkout hit the cap: opcache-build run 43611818118).
	// 8192 passed the cap (14 of 96), memory (a /_headroom reach of 108 MiB or more after a cap0 compile
	// boot, against the 32 MiB line) and normal requests (544 KiB held): #570 issuecomment-6880689593
	// and -6880882169.
	assert.equal(SITE_HOLD_BYTES, 8192 * 1024);
});

// #569 audit (the #568 class: a promise that outlives its request). workerd may drop work that is
// not awaited by a live request, so a fetch in flight when a request ends must not be WAITED on by
// the next request, and its late result must not land in the next request's held packs.
test('a fetch still in flight at endRequest is not waited on by the next request', async () => {
	let release;
	const hang = new Promise(() => {}); // a fetch workerd dropped: it never settles
	let calls = 0;
	const stats = {};
	const r = createRemotePacks({ index, parse, stats, holdBytes: 2000, fetchPack: async (name) => {
		calls++;
		if (calls === 1) return hang;
		return bytes[Number(name.slice(3, 4))].slice();
	} });
	const first = r.open('f0'); // request 1 ends while this is in flight
	assert.ok(first);
	r.endRequest();
	const second = r.open('f0'); // request 2 must fetch again, not wait on request 1's promise
	assert.ok(second && second !== first, 'a NEW fetch, not the dropped one');
	await second;
	assert.ok(r.data('f0'));
	assert.equal(calls, 2);
});

test('a late result of an ended request does not land in the next request', async () => {
	let finish;
	const late = new Promise((ok) => { finish = ok; });
	let calls = 0;
	const stats = {};
	const r = createRemotePacks({ index, parse, stats, holdBytes: 2000, fetchPack: async (name) => {
		calls++;
		return calls === 1 ? late : bytes[Number(name.slice(3, 4))].slice();
	} });
	const first = r.open('f1');
	r.endRequest();
	finish(bytes[1].slice()); // request 1's fetch settles AFTER its request ended
	await first.catch(() => {});
	assert.equal(r.data('f1'), null, 'not held in request 2');
	assert.equal(r.heldPacks(), 0);
});

// The lead's nit on #572: a fetch that REJECTS after its request ended rethrows into a chain nobody
// awaits any more, so it surfaced as an unhandled rejection (a log line per stale fetch). It must
// stay a rejection for anyone who IS waiting, but never be unhandled.
test('a stale fetch that rejects after its request ended is not an unhandled rejection', async () => {
	const seen = [];
	const onUnhandled = (e) => seen.push(String(e && e.message));
	process.on('unhandledRejection', onUnhandled);
	try {
		let fail;
		const late = new Promise((_, no) => { fail = no; });
		const stats = {};
		const r = createRemotePacks({ index, parse, stats, holdBytes: 2000, fetchPack: async () => late });
		r.open('f2'); // nobody keeps or awaits this one: the request is about to end
		r.endRequest();
		fail(new Error('oc-2.zip answered 503'));
		for (let i = 0; i < 5; i++) await new Promise((ok) => setImmediate(ok));
		assert.deepEqual(seen, [], 'no unhandled rejection');
		assert.equal(stats.rfFail, 0, 'a stale failure is not counted');
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}
});

// #1169 (strummer, cf759hl, 45 boots): a booted request spent a median 1,697 ms on 32 SERIAL pack fetches, PHP paused on
// each. Measured locally: a cold boot reads the NEXT pack in index order on half its steps, and PHP works about 50 ms
// between demands (a live fetch is about 54 ms). readAhead: when a pack is fetched for an open, the next one(s) are
// fetched alongside, hidden behind PHP's work. Never at the cost of correctness: a read-ahead is HELD only if it fits the
// budget WITHOUT evicting anything (files are read lazily from held packs, so evicting the pack in use would fail reads),
// it leaves headroom in the fetch cap for real opens, and a failed read-ahead is no mark on a later open.
function makeAhead(holdBytes, { cap = 64, readAhead = 1, fail = new Set(), slow = 0, aheadSlackBytes } = {}) {
	const fetched = [];
	const stats = {};
	const r = createRemotePacks({ index, parse, stats, cap, holdBytes, readAhead, aheadSlackBytes, fetchPack: async (name) => { fetched.push(name); if (slow) await new Promise((ok) => setTimeout(ok, slow)); if (fail.has(name)) throw new Error('boom'); return bytes[Number(name.slice(3, 4))].slice(); } });
	return { r, fetched, stats };
}
test('#1169 read-ahead: opening pack 0 also fetches pack 1, and the open of f1 finds it (no wait, counted as a hit)', async () => {
	const { r, fetched, stats } = makeAhead(3000);
	await open(r, 'f0');
	await new Promise((ok) => setTimeout(ok, 5));
	assert.deepEqual(fetched, ['oc-0.zip', 'oc-1.zip'], 'the next pack was fetched alongside');
	assert.equal(r.open('f1'), null, 'already held: f1 opens without a wait');
	assert.equal(stats.rfAhead, 2, 'opening f1 read ahead pack 2 in turn');
	assert.equal(stats.rfAheadHit, 1);
	assert.equal(stats.rfN, 3, 'every fetch counted');
});
test('#1169 read-ahead: an open of a pack still in flight waits on that one fetch, never a second', async () => {
	const { r, fetched } = makeAhead(3000, { slow: 20 });
	const p0 = r.open('f0');
	await p0;
	const p1 = r.open('f1');
	assert.ok(p1, 'still in flight: a promise');
	await p1;
	assert.equal(fetched.filter((n) => n === 'oc-1.zip').length, 1);
	assert.ok(r.data('f1'));
});
// Measured (order1169b, the first rule): "fit with no eviction" almost never held while streaming (the held set sits at
// the budget): 3 read-aheads, 1 hit in a cold boot. A read-ahead may use ONE pack of slack above the budget
// (aheadSlackBytes, default the largest pack), still never evicting; the real open's hold trims back to the budget.
test('#1169 read-ahead within the slack: fetched and held above the budget by one pack, the pack in use never evicted', async () => {
	const { r, fetched, stats } = makeAhead(1000);
	await open(r, 'f0');
	await new Promise((ok) => setTimeout(ok, 5));
	assert.ok(r.data('f0'), 'the pack in use stays');
	assert.ok(r.data('f1'), 'the read-ahead is held, in the slack');
	assert.equal(stats.rfAhead, 1);
	await open(r, 'f1');
	assert.equal(r.heldPacks() <= 2, true);
	assert.equal(fetched.filter((n) => n === 'oc-1.zip').length, 1);
});
test('#1169 read-ahead never evicts: with no slack and no room, it is not fetched and the pack in use stays', async () => {
	const { r, fetched, stats } = makeAhead(1000, { aheadSlackBytes: 0 });
	await open(r, 'f0');
	await new Promise((ok) => setTimeout(ok, 5));
	assert.ok(r.data('f0'), 'the pack in use was not evicted');
	assert.equal(r.data('f1'), null, 'no room: not held');
	assert.equal(fetched.includes('oc-1.zip'), false, 'no room: not even fetched');
	assert.equal(stats.rfAhead || 0, 0);
});
test('#1169 read-ahead leaves headroom in the fetch cap for real opens', async () => {
	const { r, fetched } = makeAhead(3000, { cap: 1 });
	await open(r, 'f0');
	await new Promise((ok) => setTimeout(ok, 5));
	assert.deepEqual(fetched, ['oc-0.zip'], 'the only fetch left went to the real open');
});
test('#1169 a failed read-ahead is no mark: the real open fetches again', async () => {
	const { r, fetched, stats } = makeAhead(3000, { fail: new Set(['oc-1.zip']) });
	await open(r, 'f0');
	await new Promise((ok) => setTimeout(ok, 5));
	assert.equal(stats.rfAheadFail, 1);
	await assert.rejects(open(r, 'f1'), 'the real open fetches again (and here fails again: EIO, a compile)');
	assert.equal(fetched.filter((n) => n === 'oc-1.zip').length, 2);
});
test('#1169 readAhead 0 (the default for any caller that does not ask) changes nothing', async () => {
	const { r, fetched } = makeAhead(3000, { readAhead: 0 });
	await open(r, 'f0');
	await new Promise((ok) => setTimeout(ok, 5));
	assert.deepEqual(fetched, ['oc-0.zip']);
});
test('#1169 index.js: the OPcache packs read one ahead (REMOTE_READAHEAD, default 1); the perf line counts it', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /remotePacks = createRemotePacks\(\{ index: OPCACHE_REMOTE, [^\n]*readAhead: remoteReadAhead\(ENV\)/);
	assert.match(src, /rfAhead: stats\.rfAhead - remote0\.rfAhead, rfAheadHit: stats\.rfAheadHit - remote0\.rfAheadHit/);
});

// Measured (order1169b with the slack): 16 read-aheads, 7 used, but 26 fetches with 9 refetches. Opening a pack
// reached out of order (17) read 18 ahead four times, never opened; and a read-ahead (1) was evicted unopened by the
// next real open's hold. So: a read-ahead wasted once (evicted or dropped unopened) is not read ahead again in the
// request, and a real open's eviction takes OPENED packs before an unopened read-ahead.
const bytes5 = [0, 1, 2, 3, 4].map((n) => new Uint8Array(1000).fill(n + 1));
const index5 = { id: 't5', packs: bytes5.map((b, n) => ({ name: 'oc-' + n + '.zip', bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') })), files: Object.fromEntries([0, 1, 2, 3, 4].map((n) => ['f' + n, [n, 4]])) };
function make5(holdBytes, readAhead = 1) {
	const fetched = [];
	const stats = {};
	const r = createRemotePacks({ index: index5, parse, stats, cap: 64, holdBytes, readAhead, aheadSlackBytes: 1000, fetchPack: async (name) => { fetched.push(name); return bytes5[Number(name.slice(3, 4))].slice(); } });
	return { r, fetched, stats };
}
const settle = () => new Promise((ok) => setTimeout(ok, 5));
test('#1169 a real open evicts an OPENED pack before an unopened read-ahead', async () => {
	const { r } = make5(2000);
	await open(r, 'f0'); await settle(); // 0 open, 1 ahead
	await open(r, 'f0'); // 0 used again: more recent than the unopened 1 in the LRU order
	await open(r, 'f3'); await settle(); // 3 open (out of order): evicts 0 (opened), not the unopened 1
	assert.ok(r.data('f1'), 'the unopened read-ahead survived');
	assert.equal(r.data('f0'), null, 'the opened pack went first');
});
test('#1169 a read-ahead wasted once is not read ahead again in the request', async () => {
	// The live pattern: an out-of-order pack (3) opened twice, its read-ahead (4) evicted unopened in between.
	const { r, fetched } = make5(2000);
	for (const f of ['f3', 'f0', 'f1', 'f2', 'f3', 'f0', 'f3']) { await open(r, f); await settle(); }
	assert.equal(fetched.filter((n) => n === 'oc-4.zip').length, 1, 'pack 4 (never opened) read ahead once, not again: ' + fetched.join(','));
});

// #1169: with read-ahead, rfMs (the sum of every fetch's duration) counts fetches PHP never waited on. rfWaitMs is the
// time OPENS waited on a pack: the number a boot's cost is, and the one the live before and after compares.
test('#1169 rfWaitMs counts only the time opens waited (a held read-ahead is no wait)', async () => {
	const { r, stats } = makeAhead(3000, { slow: 30 });
	await open(r, 'f0');
	const w0 = stats.rfWaitMs;
	assert.ok(w0 >= 25, 'the first open waited its fetch: ' + w0);
	await new Promise((ok) => setTimeout(ok, 60)); // the read-ahead of pack 1 lands while "PHP works"
	await open(r, 'f1');
	assert.ok(stats.rfWaitMs - w0 < 10, 'the read-ahead was held: no wait (' + (stats.rfWaitMs - w0) + ' ms)');
	assert.ok(stats.rfMs >= 50, 'rfMs still sums both fetches');
});
