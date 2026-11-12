// A request whose writes were lost to an isolate memory reset must never answer success (#350).
//
// When the PHP object's isolate exceeds its memory and the platform resets it in the middle of a
// request, every storage statement after that point fails with "Durable Object's isolate exceeded
// its memory limit and was reset." PHP does not stop: WordPress sees a failed query, carries on, and
// the request answered success. Seen live on fdprobe1112h (2026-11-12): a login answered 302 with its
// auth cookies, but the session_tokens write had failed (x-d1-failures 3, x-db-rows written=0), so
// the next request asked to log in again. A checkout can lose its writes the same way.
//
// Measured on the same site: the statements that ran BEFORE the reset are durable (a marker row
// written first survived, the one written after did not). So the state may be partly saved, and a
// blind retry can repeat what was saved (a second order). The answer is therefore a 500 that says
// so, with no Retry-After and no Set-Cookie: never a 503 "try again", never PHP's own answer.
import { MEMORY_RESET } from './object-error.mjs';

/** How many of a run's statement failures are the isolate memory reset. */
export function resetFailures(failures) {
	let n = 0;
	for (const f of failures || []) if (f && MEMORY_RESET.test(String(f.error || ''))) n++;
	return n;
}

export const WRITE_LOSS_MESSAGE = 'The request did not complete, and some changes may have been saved. Check before you try again.';
export const WRITE_LOSS_BODY = WRITE_LOSS_MESSAGE + '\n';
export const WRITE_LOSS_CODE = 'skyphusion_write_loss';

/**
 * An API call gets JSON (the lead's ruling): a REST route (/wp-json/ or ?rest_route=) or a client
 * that asks for JSON. The Store API checkout client then shows the message instead of failing to
 * parse a text body.
 */
export function wantsJson(pathname, search, accept) {
	if (String(pathname || '').startsWith('/wp-json/')) return true;
	if (/(^|[?&])rest_route=/.test(String(search || ''))) return true;
	return /application\/json/i.test(String(accept || ''));
}

/**
 * The answer for a request whose writes may be partly saved: status, headers, body. n is the
 * number of statements that failed in the reset, or 'unknown' when the reset killed the whole
 * request (the object answered nothing). No Retry-After, no Set-Cookie, never cached.
 */
export function writeLossResponse(n, json = false) {
	const headers = {
		'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		'x-isolate-reset': 'memory',
		'x-write-loss': String(n),
	};
	const body = json ? JSON.stringify({ code: WRITE_LOSS_CODE, message: WRITE_LOSS_MESSAGE, data: { status: 500 } }) : WRITE_LOSS_BODY;
	return { status: 500, headers, body };
}
