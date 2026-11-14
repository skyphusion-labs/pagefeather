// One reused inflate arena per isolate (#394 step 2, design issuecomment-6871363238; LAZY_ARENA=on).
//
// Every lazily inflated bundle file used to get a new Uint8Array(size). The cache kept only
// LAZY_CACHE_BYTES of them referenced, and the dropped copies stayed in the isolate until V8 collected
// them: a fresh-boot post-new had inflated 55.5 MiB by its failing INSERT, in 26 of 26 failures
// (op48inf, pf394a, 2026-11-14), the memory that took the isolate over its line.
//
// The arena is one Uint8Array, made once and never dropped. alloc(size, drop) hands out a region as a
// ring: the next region starts at the head and wraps to 0 when it does not fit. Every live entry whose
// region overlaps the new one is EVICTED first, by calling its drop() (attachLazyContents nulls the
// node's contents), so no node keeps a view of bytes that are about to be overwritten. A file larger
// than the arena gets null (the caller makes its own buffer, as before). MEMFS reads copy out of
// contents synchronously, so a region cannot be reused in the middle of a read.

export function createArena(bytes) {
	const buf = new Uint8Array(bytes);
	let head = 0;
	let live = []; // { start, end, drop }, in allocation order
	const counts = { allocs: 0, evicts: 0, over: 0, bytes: 0 };
	return {
		size: bytes,
		counts,
		/** A region of `size` bytes for one inflate, or null when it does not fit the arena at all. */
		alloc(size, drop) {
			if (!(size > 0) || size > bytes) {
				counts.over++;
				return null;
			}
			let start = head;
			if (start + size > bytes) start = 0;
			const end = start + size;
			const keep = [];
			for (const e of live) {
				if (false && e.start < end && start < e.end) { // MUTANT: do not merge (#508 CI red check)
					counts.evicts++;
					try { e.drop(); } catch { /* a drop never stops the inflate */ }
				} else {
					keep.push(e);
				}
			}
			live = keep;
			live.push({ start, end, drop });
			head = end;
			counts.allocs++;
			counts.bytes += size;
			return buf.subarray(start, end);
		},
		/** Drop every live entry (after a request, as evictLazy drops the cache). The arena stays. */
		evictAll() {
			for (const e of live) {
				try { e.drop(); } catch { /* ignore */ }
			}
			live = [];
			head = 0;
		},
		/** For tests: the live entries. */
		liveCount() { return live.length; },
	};
}
