// The object cache's KV L2 reads on approach A, with a negative L1 (#1078).
// Measured on cf759hl (Hyperdrive, westus2): a WooCommerce list page waited 11.2 to 12.0 s on about 92 OC_KV.get misses,
// awaited one after another at about 125 ms each, and the SAME keys missed on every render. Two changes:
//   (a) a KV miss is remembered in the isolate (a negative entry), so a key nobody stores costs one KV read per isolate
//       per version instead of one per render;
//   (b) the misses of one bridge call go to KV in parallel.
// Correctness (the lead's rule): a negative entry must never hide a value another isolate writes later.
//   - A version-salted key (the drop-in's pkey "group NUL v<N> NUL key"; options under #296 (2)) changes with every
//     write anywhere: an AFTER trigger bumps the version in the same statement, and every request reads the version at
//     its start. A newer value lives under a NEW key, so the old negative entry is never asked again. It is kept for a
//     bound (memory, not correctness).
//   - Any other key lives the SHORT TTL, the same bound its positive L1 entry already has (OBJECT_CACHE_TTL).
//   - A negative hit is a miss: PHP falls through to MySQL. For options, MySQL is the source of truth.
//   - A KV ERROR is a miss but is NOT remembered: a transient fault must not hide a key.
const VERSIONED_KEY = /^[^\0]*\0v\d+\0/;

/** True for a version-salted key (the drop-in pkey "group NUL v<N> NUL key"). */
export function isVersionedKey(key) {
	return VERSIONED_KEY.test(String(key));
}

/** The negative entry's life for a key: the versioned bound for a version-salted key, else the short TTL. */
export function negTtlMs(key, shortMs, versionedMs) {
	return isVersionedKey(key) ? versionedMs : shortMs;
}

/**
 * A POSITIVE L1 entry's expiry (#1078 round 2): a versioned key cannot go stale (a write anywhere renames it), so it has
 * no time bound (0) and only the isolate's L1 memory cap evicts it; any other key keeps the short TTL.
 */
export function l1ExpFor(key, now, shortMs) {
	return isVersionedKey(key) ? 0 : now + shortMs;
}

/** An isolate's remembered KV misses: key -> expiry, insertion-ordered, at most max entries (oldest go first). */
export function createNegCache({ max = 4096 } = {}) {
	const m = new Map();
	return {
		has(k, now) {
			const exp = m.get(k);
			if (exp === undefined) return false;
			if (exp <= now) {
				m.delete(k);
				return false;
			}
			return true;
		},
		miss(k, now, ttlMs) {
			if (!(ttlMs > 0)) return;
			m.delete(k);
			m.set(k, now + ttlMs);
			while (m.size > max) m.delete(m.keys().next().value);
		},
		clear(k) {
			m.delete(k);
		},
		get size() {
			return m.size;
		},
	};
}

/**
 * Read keys (already missing the positive L1) from KV: negative entries first, the rest in parallel.
 * Returns { values (null = miss), kvReads, kvMs, negHits, hits }.
 */
export async function readL2(keys, { now, neg, kvGet, ttlFor }) {
	const values = new Array(keys.length).fill(null);
	const need = [];
	let negHits = 0;
	keys.forEach((k, i) => {
		if (neg.has(k, now)) negHits++;
		else need.push(i);
	});
	let kvMs = 0, hits = 0;
	if (need.length) {
		const t = Date.now();
		const got = await Promise.all(need.map((i) => kvGet(keys[i]).then((v) => ({ v }), () => ({ err: true }))));
		kvMs = Date.now() - t;
		need.forEach((i, j) => {
			const g = got[j];
			if (g.err) return; // a miss, not remembered
			if (g.v !== null && g.v !== undefined) {
				values[i] = g.v;
				hits++;
			} else neg.miss(keys[i], now, ttlFor(keys[i]));
		});
	}
	return { values, kvReads: need.length, kvMs, negHits, hits };
}
