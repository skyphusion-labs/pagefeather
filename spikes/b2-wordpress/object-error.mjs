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
// #976, measured 2026-11-19 14:19:16Z on cf759a (build 83056b7). stub.fetch threw
// "internal error; reference = <id>". The stack was raceFetch. The object did not
// log the path. The worker rethrew it, and the dispatcher answered 502.
// This is not the #398 storage reset. That sentence names storage and a reset.
// The match is the whole message. The reference id is not part of the match.
// A bare "internal error" is not this.
// #1004: this stays 'internal' (not a reset, and not retried). A method that may
// have written still takes the write-loss path. The measured call did not enter
// PHP. A checkout may already have written rows, so "try again" can duplicate it.
// GET, HEAD and OPTIONS keep the 503.
export const PLATFORM_INTERNAL = /^internal error; reference = [a-z0-9]+$/i;

/**
 * 'memory' for an isolate memory reset, 'storage' for a storage reset, 'internal' for the
 * #976 platform error, 'overloaded' for a full queue, null for anything else. A reset is
 * checked before the overloaded flag: the platform sets e.overloaded on a memory reset too.
 */
export function classifyObjectError(e) {
	const msg = String((e && e.message) || e || '');
	if (MEMORY_RESET.test(msg)) return 'memory';
	if (STORAGE_RESET.test(msg)) return 'storage';
	if (PLATFORM_INTERNAL.test(msg)) return 'internal';
	if ((e && e.overloaded === true) || OVERLOADED.test(msg)) return 'overloaded';
	return null;
}

/** A kind where the platform reset the object (memory or storage), not a full queue. */
export function isResetKind(kind) {
	return kind === 'memory' || kind === 'storage';
}

// Retry once (#335, the lead's ruling 2026-11-12). A memory reset kills every request in the
// isolate, also a page that only queued behind the cron tick; the same page on the next isolate
// answered 200 after each of the 13 cold 503s measured on fdprobe1112g. So a GET, HEAD or OPTIONS is
// sent once more. Never a POST or any other method: it may have run in part (an order, a login) before
// the reset. Never a full queue: a retry adds load to it. Never a second time.
// OPTIONS (#589, the lead's ruling): a safe method by HTTP's contract, like GET and HEAD, and WordPress
// answers it from the route schema. In the block editor round, 5 OPTIONS /wp/v2/... that died in a reset
// each got the write-loss 500 "may have been saved", though it writes nothing.
export const RETRY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A method that may have changed state (anything but GET, HEAD or OPTIONS). After a memory reset its earlier
 * writes may be saved (measured on fdprobe1112h, #350), so it is never retried and never told to try
 * again: it gets write-loss.mjs's 500 "may have been saved" answer.
 */
export function mayHaveWritten(method) {
	return !RETRY_METHODS.has(String(method || '').toUpperCase());
}

/**
 * What the front Worker answers for a classified failure that was not (or no longer) retried:
 * 'write-loss' (write-loss.mjs: frame probe, then rolled back only when the frame proves it,
 * otherwise the 500 "may have been saved") for a reset, or for a platform internal error
 * (#1004), on a method that may have written. Otherwise '503' (objectErrorHeaders).
 * GET, HEAD and OPTIONS stay 503. A full queue stays 503: the request never ran.
 * An unclassified error never gets here: it is thrown.
 */
export function objectErrorOutcome(kind, method) {
	return (isResetKind(kind) || kind === 'internal') && mayHaveWritten(method) ? 'write-loss' : '503';
}


/** True for a callPhpObject deadline (#605): the object did not start answering in time. */
export function isObjectCallDeadlineError(e) {
	return !!(e && e.deadline === true && e.response);
}

/** Retry once on #605 no-answer for safe methods, same rule as a memory reset. */
export function shouldRetryObjectDeadline(method, attempt) {
	return attempt === 0 && RETRY_METHODS.has(String(method || '').toUpperCase());
}

/** Retry this failure? Only a reset (memory or storage, #398), only a GET, HEAD or OPTIONS, only the first attempt. */
export function shouldRetryObjectError(kind, method, attempt) {
	return isResetKind(kind) && RETRY_METHODS.has(String(method || '').toUpperCase()) && attempt === 0;
}

/**
 * Call send(attempt) and retry it once by shouldRetryObjectError. Returns { r, attempts } on an
 * answer, { deadline, attempts, deadlineMs } when the object call deadline fired (#605), or { error, kind, attempts } for a classified failure that is not retried (again).
 * An error classifyObjectError does not know is thrown, as before. send makes its own stub and
 * request each time: a stub that saw the reset is not reused.
 */
export async function fetchWithMemoryRetry(send, method, onRetry) {
	for (let attempt = 0; ; attempt++) {
		try {
			return { r: await send(attempt), attempts: attempt + 1 };
		} catch (e) {
			const kind = classifyObjectError(e);
			if (kind) {
				if (shouldRetryObjectError(kind, method, attempt)) {
					if (onRetry) await onRetry(e, attempt);
					continue;
				}
				return { error: e, kind, attempts: attempt + 1 };
			}
			if (isObjectCallDeadlineError(e)) {
				if (shouldRetryObjectDeadline(method, attempt)) {
					if (onRetry) await onRetry(e, attempt);
					continue;
				}
				return { deadline: e.response, attempts: attempt + 1, deadlineMs: e.deadlineMs };
			}
			throw e;
		}
	}
}

/** The 503 headers for a classified error (never stored by a cache). */
export function objectErrorHeaders(kind, objectName, retryAfterS) {
	const h = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': retryAfterS, 'x-php-object': objectName };
	if (isResetKind(kind)) h['x-isolate-reset'] = kind;
	else if (kind === 'internal') h['x-platform-error'] = 'internal';
	else h['x-overloaded'] = '1';
	return h;
}
