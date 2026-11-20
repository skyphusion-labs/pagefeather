// The isolate L1 life of an object-cache key on approach A (#1078).
// Options persist across requests under their exact version (#296 (2)): the drop-in's pkey is "group NUL v<N> NUL key",
// and an AFTER trigger bumps the version in the same statement as any options write, so a write renames every options
// key and every request reads the version at its start. A versioned key therefore cannot go stale: its L1 entry has no
// time bound, and the L1 memory cap evicts it. Any other key keeps the short TTL (OBJECT_CACHE_TTL).
// Measured on cf759hl with the KV L2 off: without this, list posts made 133 queries and trash post 118 (each request more
// than 10 s after the last re-read every options key from MySQL); with it, 74 and 73.
const VERSIONED_KEY = /^[^\0]*\0v\d+\0/;

/** True for a version-salted key. */
export function isVersionedKey(key) {
	return VERSIONED_KEY.test(String(key));
}

/** A positive L1 entry's expiry: 0 (no time bound) for a versioned key, else now + the short TTL. */
export function l1ExpFor(key, now, shortMs) {
	return isVersionedKey(key) ? 0 : now + shortMs;
}
