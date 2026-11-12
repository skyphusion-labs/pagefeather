// What a failed call to the PHP Durable Object was (issue #335).
//
// stub.fetch() throws when the object cannot answer. Two kinds come back with e.overloaded set:
//   - "Durable Object is overloaded": the object's queue is full (docs/perf-dosql.md). The site
//     is busy, and a retry after a few seconds is right.
//   - "Durable Object's isolate exceeded its memory limit and was reset.": the isolate ran out of
//     its 128 MiB and the platform reset it, with every request in it. Not a queue.
// Before #335 both answered 503 with x-overloaded: 1. On fdprobe1112g (2026-11-12) every cold
// 503 tagged x-overloaded was a memory reset (Workers Logs: outcome exceededMemory), so the
// header named the wrong phase. Now each kind has its own header.
export const MEMORY_RESET = /exceeded its memory limit/i;
export const OVERLOADED = /Durable Object is overloaded/i;

/** 'memory' for an isolate memory reset, 'overloaded' for a full queue, null for anything else. */
export function classifyObjectError(e) {
	const msg = String((e && e.message) || e || '');
	if (MEMORY_RESET.test(msg)) return 'memory';
	if ((e && e.overloaded === true) || OVERLOADED.test(msg)) return 'overloaded';
	return null;
}

/** The 503 headers for a classified error (never stored by a cache). */
export function objectErrorHeaders(kind, objectName, retryAfterS) {
	const h = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': retryAfterS, 'x-php-object': objectName };
	if (kind === 'memory') h['x-isolate-reset'] = 'memory';
	else h['x-overloaded'] = '1';
	return h;
}
