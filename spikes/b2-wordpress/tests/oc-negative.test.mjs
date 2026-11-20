// node --test spikes/b2-wordpress/tests/oc-negative.test.mjs (#1078)
// cf759hl (approach A, Hyperdrive): a WooCommerce list page waited 11.2 to 12.0 s on about 92 OC_KV.get misses, one after
// another at about 125 ms each, and the SAME keys missed on every render (l2Hits 0 or 1). The isolate now remembers a
// KV miss (a negative L1 entry), so a key nobody stores costs one KV read per isolate per version, not one per render,
// and a request's misses go to KV in parallel.
// The correctness rule (the lead's): a negative entry must never hide a value another isolate writes later. A versioned
// key carries its group's exact version as salt (options: AFTER triggers bump it in the same statement as the write), so
// a write anywhere moves every key and the old negative entry is never asked again. An unversioned key's negative entry
// lives only the short TTL (the same bound its positive L1 entry already has).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNegCache, negTtlMs, readL2 } from '../oc-negative.mjs';

const SHORT = 10_000, VERSIONED = 600_000;
const vkey = (v, k) => 'options\0v' + v + '\0' + k; // the drop-in pkey: group NUL salt NUL key
const ukey = (k) => 'theme_json\0' + k;

// One "isolate": its negative cache, reading through the shared KV (a Map) with readL2.
function isolate(kv) {
	const neg = createNegCache({ max: 1000 });
	return {
		neg,
		read: (keys, now) => readL2(keys, { now, neg, kvGet: async (k) => (kv.has(k) ? kv.get(k) : null), ttlFor: (k) => negTtlMs(k, SHORT, VERSIONED) }),
	};
}

test('CROSS-ISOLATE (versioned): isolate 1 caches "absent", isolate 2 sets the key, isolate 1 reads the new value after the version bump', async () => {
	const kv = new Map();
	const i1 = isolate(kv);
	let r = await i1.read([vkey(5, 'x')], 1000);
	assert.deepEqual(r.values, [null]);
	assert.equal(r.kvReads, 1);
	// Isolate 2 writes the option: MySQL bumps the options version to 6 in the same statement, and its cache set lands
	// under the new key.
	kv.set(vkey(6, 'x'), 'NEW');
	// Isolate 1's next request reads the version (6) at its start, so it asks for the v6 key: the old negative entry
	// is never consulted, and the new value is read.
	r = await i1.read([vkey(6, 'x')], 2000);
	assert.deepEqual(r.values, ['NEW'], 'the bump makes the negative entry unreachable');
});
test('versioned: a remembered miss is not read again within the version (the 92-key cure), and a miss only sends PHP to MySQL', async () => {
	const kv = new Map();
	const i1 = isolate(kv);
	const keys = Array.from({ length: 92 }, (_, n) => vkey(5, 'k' + n));
	let r = await i1.read(keys, 1000);
	assert.equal(r.kvReads, 92);
	r = await i1.read(keys, 5000);
	assert.equal(r.kvReads, 0, 'the second render pays no KV read');
	assert.equal(r.negHits, 92);
	assert.ok(r.values.every((v) => v === null), 'a negative hit is a miss: PHP falls through to MySQL, the source of truth for options');
	r = await i1.read(keys, 1000 + VERSIONED + 1);
	assert.equal(r.kvReads, 92, 'bounded: re-read after the versioned bound');
});
test('CROSS-ISOLATE (unversioned): isolate 2 sets the key; isolate 1 sees it once the short TTL ends, never later', async () => {
	const kv = new Map();
	const i1 = isolate(kv);
	await i1.read([ukey('t')], 1000);
	kv.set(ukey('t'), 'NEW');
	let r = await i1.read([ukey('t')], 1000 + SHORT - 1);
	assert.deepEqual(r.values, [null], 'within the short TTL (the posture unversioned L1 entries already have)');
	r = await i1.read([ukey('t')], 1000 + SHORT + 1);
	assert.deepEqual(r.values, ['NEW']);
});
test('a set or delete in this isolate clears its negative entry at once', async () => {
	const kv = new Map();
	const i1 = isolate(kv);
	await i1.read([vkey(5, 'x')], 1000);
	assert.ok(i1.neg.has(vkey(5, 'x'), 1001));
	i1.neg.clear(vkey(5, 'x'));
	assert.ok(!i1.neg.has(vkey(5, 'x'), 1002));
});
test('the misses of one call go to KV in parallel, not one after another', async () => {
	let inFlight = 0, peak = 0;
	const neg = createNegCache({ max: 1000 });
	const kvGet = async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((ok) => setTimeout(ok, 5)); inFlight--; return null; };
	const r = await readL2(Array.from({ length: 20 }, (_, n) => vkey(1, 'p' + n)), { now: 1, neg, kvGet, ttlFor: () => SHORT });
	assert.equal(r.kvReads, 20);
	assert.equal(peak, 20);
});
test('a KV error is a miss but is NOT remembered (a transient fault must not hide a key)', async () => {
	const neg = createNegCache({ max: 1000 });
	const r = await readL2([vkey(1, 'e')], { now: 1, neg, kvGet: async () => { throw new Error('kv down'); }, ttlFor: () => SHORT });
	assert.deepEqual(r.values, [null]);
	assert.ok(!neg.has(vkey(1, 'e'), 2));
});
test('bounded memory: the oldest negative entries go first past max', () => {
	const neg = createNegCache({ max: 3 });
	for (const k of ['a', 'b', 'c', 'd']) neg.miss(k, 1, SHORT);
	assert.equal(neg.size, 3);
	assert.ok(!neg.has('a', 2) && neg.has('d', 2));
});
test('negTtlMs: a version-salted key gets the versioned bound, any other the short TTL', () => {
	assert.equal(negTtlMs(vkey(42, 'x'), SHORT, VERSIONED), VERSIONED);
	assert.equal(negTtlMs(ukey('x'), SHORT, VERSIONED), SHORT);
	assert.equal(negTtlMs('options\0x', SHORT, VERSIONED), SHORT, 'options with no version read: unversioned');
});
test('index.js: objectCacheOp reads L2 through readL2 with the negative cache, and set and del clear it', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{ createNegCache, negTtlMs, readL2[^}]*\} from '\.\/oc-negative\.mjs';/);
	assert.match(src, /await readL2\(/);
	assert.match(src, /ocNeg\.clear\(op\.k\)/);
	assert.match(src, /for \(const k of op\.k\) \{ ocNeg\.clear\(k\);/);
	assert.doesNotMatch(src, /for \(const k of op\.k\) \{\n\t\t\tocCount\(k, "get"\);/, 'the old sequential per-key loop is gone');
});

// #1078 round 2 (the lead): a KV HIT is a round trip too (about 125 ms on cf759hl), and a versioned key cannot go stale
// (a write anywhere renames it), so its POSITIVE L1 entry is bounded by memory, not by the 10 s OBJECT_CACHE_TTL. Any
// other key keeps the short TTL. And the perf line splits the L2 reads into batched and single-key calls, so run 4
// says whether the after-write misses come through get_multiple (the parallel reads cure them) or get().
import { l1ExpFor } from '../oc-negative.mjs';
test('l1ExpFor: a versioned key never expires by time (memory bounds it); any other key the short TTL', () => {
	assert.equal(l1ExpFor(vkey(7, 'alloptions'), 1000, SHORT), 0);
	assert.equal(l1ExpFor(ukey('x'), 1000, SHORT), 1000 + SHORT);
	assert.equal(l1ExpFor('options\0x', 1000, SHORT), 1000 + SHORT, 'options with no version read: short');
});
test('CROSS-ISOLATE (positive, versioned): a long-lived L1 value is never served for a newer version', async () => {
	// Isolate 1 holds alloptions under v7 with no time bound. Isolate 2 writes an option (v7 -> v8). Isolate 1's next
	// request reads version 8 at its start and asks for the v8 key, which its L1 has never held: the v7 value is unreachable.
	const l1 = new Map([[vkey(7, 'alloptions'), { v: 'OLD', exp: l1ExpFor(vkey(7, 'alloptions'), 0, SHORT) }]]);
	assert.equal(l1.get(vkey(8, 'alloptions')), undefined);
	assert.equal(l1.get(vkey(7, 'alloptions')).exp, 0);
});
test('index.js: an L2 hit and a set store versioned keys with l1ExpFor; the L2 reads are split batched vs single', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /ocStore\(k, kv, l1ExpFor\(k, now, ocTtlMs\(\)\)\)/);
	assert.match(src, /ocStore\(op\.k, op\.v, isVersionedKey\(op\.k\) \? 0 : op\.ttl > 0 \? now \+ op\.ttl \* 1000 : 0\)/);
	assert.match(src, /if \(op\.k\.length === 1\) \{ stats\.l2SingleN \+= r\.kvReads; stats\.l2SingleMs \+= r\.kvMs; \} else \{ stats\.l2BatchN \+= r\.kvReads; stats\.l2BatchMs \+= r\.kvMs; stats\.l2Batches\+\+; \}/);
});
