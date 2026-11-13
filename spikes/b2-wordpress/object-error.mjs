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
//
// A third kind (#398): "Internal error in Durable Object storage caused object to be reset;
// reference = <id>". The platform reset the object, with every request in it, as in a memory reset.
// Seen on tsv1113w (2026-11-13): 4 admin writes and a login died this way, and 2 of the writes WERE
// saved. Before #398 it was not classified, so it was thrown and the WfP dispatcher answered 502.
// The match is on the stable text only, never on the reference id.
export const MEMORY_RESET = /exceeded its memory limit/i;
export const STORAGE_RESET = /Durable Object storage caused object to be reset/i;
export const OVERLOADED = /Durable Object is overloaded/i;

/**
 * 'memory' for an isolate memory reset, 'storage' for a storage reset, 'overloaded' for a full
 * queue, null for anything else. A reset is checked before the overloaded flag: the platform sets
 * e.overloaded on a memory reset too.
 */
export function classifyObjectError(e) {
	const msg = String((e && e.message) || e || '');
	if (MEMORY_RESET.test(msg)) return 'memory';
	if (STORAGE_RESET.test(msg)) return 'storage';
	if ((e && e.overloaded === true) || OVERLOADED.test(msg)) return 'overloaded';
	return null;
}

/** A kind where the platform reset the object (memory or storage), not a full queue. */
export function isResetKind(kind) {
	return kind === 'memory' || kind === 'storage';
}

// Retry once (#335, the lead's ruling 2026-11-12). A memory reset kills every request in the
// isolate, also a page that only queued behind the cron tick; the same page on the next isolate
// answered 200 after each of the 13 cold 503s measured on fdprobe1112g. So a GET or HEAD is sent
// once more. Never a POST or any other method: it may have run in part (an order, a login) before
// the reset. Never a full queue: a retry adds load to it. Never a second time.
export const RETRY_METHODS = new Set(['GET', 'HEAD']);

/**
 * A method that may have changed state (anything but GET or HEAD). After a memory reset its earlier
 * writes may be saved (measured on fdprobe1112h, #350), so it is never retried and never told to try
 * again: it gets write-loss.mjs's 500 "may have been saved" answer.
 */
export function mayHaveWritten(method) {
	return !RETRY_METHODS.has(String(method || '').toUpperCase());
}

/**
 * What the front Worker answers for a classified failure that was not (or no longer) retried:
 * 'write-loss' (write-loss.mjs, the 500 "may have been saved") for a reset on a method that may
 * have written, else '503' (objectErrorHeaders). An unclassified error never gets here: it is thrown.
 */
export function objectErrorOutcome(kind, method) {
	return isResetKind(kind) && mayHaveWritten(method) ? 'write-loss' : '503';
}

/** Retry this failure? Only a reset (memory or storage, #398), only a GET or HEAD, only the first attempt. */
export function shouldRetryObjectError(kind, method, attempt) {
	return isResetKind(kind) && RETRY_METHODS.has(String(method || '').toUpperCase()) && attempt === 0;
}

/**
 * Call send(attempt) and retry it once by shouldRetryObjectError. Returns { r, attempts } on an
 * answer, or { error, kind, attempts } for a classified failure that is not retried (again).
 * An error classifyObjectError does not know is thrown, as before. send makes its own stub and
 * request each time: a stub that saw the reset is not reused.
 */
export async function fetchWithMemoryRetry(send, method, onRetry) {
	for (let attempt = 0; ; attempt++) {
		try {
			return { r: await send(attempt), attempts: attempt + 1 };
		} catch (e) {
			const kind = classifyObjectError(e);
			if (!kind) throw e;
			if (shouldRetryObjectError(kind, method, attempt)) {
				if (onRetry) onRetry(e, attempt);
				continue;
			}
			return { error: e, kind, attempts: attempt + 1 };
		}
	}
}

/** The 503 headers for a classified error (never stored by a cache). */
export function objectErrorHeaders(kind, objectName, retryAfterS) {
	const h = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': retryAfterS, 'x-php-object': objectName };
	if (isResetKind(kind)) h['x-isolate-reset'] = kind;
	else h['x-overloaded'] = '1';
	return h;
}
