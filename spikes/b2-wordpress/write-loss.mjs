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
// #352: the request frame was rolled back, PROVEN by the object's /_frame probe (state rolled-back, no
// commit point passed): nothing of the request was kept, so a retry is safe. Never sent without the proof.
export const ROLLED_BACK_MESSAGE = 'The request did not complete. Nothing was saved. You can try again.';
// kind 'memory' and 'storage' are isolate resets (#398). kind 'internal' is a platform
// fault (#976, #1004): the same marker objectErrorHeaders uses, and no x-isolate-reset.
// A false x-isolate-reset: memory would be counted with the real memory resets.
function lossKindHeaders(kind) {
	if (kind === 'internal') return { 'x-platform-error': 'internal' };
	return { 'x-isolate-reset': kind === 'storage' ? 'storage' : 'memory' };
}
/** The #352 answer when the frame is proven rolled back: still a 500, never a 302 with half a save. */
export function rolledBackResponse(json = false, kind = 'memory', undone = 0) {
	const headers = {
		'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		...lossKindHeaders(kind),
		'x-write-loss': 'rolled-back',
		'x-write-undone': String(Number(undone) || 0),
	};
	const body = json ? JSON.stringify({ code: WRITE_LOSS_CODE, message: ROLLED_BACK_MESSAGE, data: { status: 500, rolledBack: true } }) : ROLLED_BACK_MESSAGE + '\n';
	return { status: 500, headers, body };
}
/**
 * #795, the lead's ruling: a failure is classed by WHAT FAILED, not where. A PLATFORM failure is something our platform
 * did TO the statement (the memory reset, which resetFailures counts and the write-loss path answers; the database busy
 * or locked; out of memory; the disk or storage full; an I/O error; a timeout or a lost connection; no reply from the
 * Worker): PHP saw an empty or unapplied result that was not the truth, so the request answers a visible, retryable
 * failure. Anything else is a DETERMINISTIC statement error (no such table, a syntax or constraint error, the LIKE
 * pattern cap, a dialect miss): the statement itself is wrong and fails again on a retry, so it goes back to WordPress
 * through wpdb's error path (the SQLite integration's _do_query sets last_error), as MySQL's errors do. An unknown
 * message is deterministic: a retry loop is worse than WordPress's own handling, and the log line names its class.
 */
export const PLATFORM_FAILURE = /exceeded its memory limit|SQLITE_BUSY|database is locked|SQLITE_NOMEM|out of memory|SQLITE_FULL|database or disk is full|SQLITE_IOERR|disk I\/O error|timed out|timeout|network connection lost|overloaded|no reply from the Worker|storage (?:reset|limit)/i;
/** The statements of a run that failed by the platform's hand (the reset among them). */
export function platformFailures(failures) {
	let n = 0;
	for (const f of failures || []) if (f && PLATFORM_FAILURE.test(String(f.error || ''))) n++;
	return n;
}
/**
 * #795: the answer to a request in which a SQL statement failed by the PLATFORM's hand, other than the isolate memory reset
 * (resetFailures counts those). Never a plausible wrong answer: PHP saw a failed read as an empty result, so its own
 * 200 or 404 would look like the truth. saved says whether the request may have kept a write:
 *   false (it wrote nothing, or its frame is proven rolled back): 503 with Retry-After, "Nothing was saved. You can try
 *         again." A retry is safe, and it gets the truth.
 *   true  (a write may have been kept): 500 with no Retry-After, as writeLossResponse: "check before you try again".
 * Both are no-store, carry x-sql-failure (the count), and claim no isolate reset (there was none).
 */
export function statementFailureResponse(n, json = false, saved = false) {
	const headers = {
		'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		'x-sql-failure': String(n),
		'x-write-loss': saved ? 'unknown' : 'none',
	};
	if (!saved) headers['retry-after'] = '5';
	const message = saved ? WRITE_LOSS_MESSAGE : ROLLED_BACK_MESSAGE;
	const status = saved ? 500 : 503;
	const body = json ? JSON.stringify({ code: WRITE_LOSS_CODE, message, data: { status, statementFailure: true } }) : message + '\n';
	return { status, headers, body };
}
/**
 * #836, the lead's ruling (option 2, 2026-11-20): a DETERMINISTIC refusal on a READ answers a non-retryable 500 that
 * names the refusal, for every request, visitors included. A plausible wrong 200 (an empty result that looks like
 * "nothing matched") is the worse error. A refusal is a limit of the platform's SQLite that MySQL does not have, so the
 * same query worked on the site's old host: the LIKE pattern cap, the bound-variable cap, the expression depth, the
 * statement or value size. An error MySQL raises too (no such table or column, syntax, a constraint) is NOT a refusal and
 * stays on wpdb's error path: WordPress relies on it (no such table is how it finds a site that is not installed yet).
 * Keep shrinking this class at the root (d1-dialect rewrites, #805 and #836 (a)), so this 500 stays rare.
 */
export const SQL_REFUSALS = [
	[/LIKE or GLOB pattern too complex/i, 'like-pattern'],
	[/too many SQL variables/i, 'too-many-variables'],
	[/Expression tree is too large|parser stack overflow/i, 'expression-depth'],
	[/string or blob too big|SQLITE_TOOBIG/i, 'too-big'],
];
export const SQL_REFUSED_CODE = 'skyphusion_sql_refused';
export const SQL_REFUSED_MESSAGE = 'The database refused a query this page needs. Nothing was changed. The same request will be refused again.';
/** The refusal a statement error names, or null when it is not one. */
export function sqlRefusal(error) {
	const e = String(error || '');
	if (!e) return null;
	for (const [re, kind] of SQL_REFUSALS) if (re.test(e)) return kind;
	return null;
}
/** The first refusal among the run's failed READS (SELECT or WITH), or null. A refused write stays on wpdb's path. */
export function readRefusal(failures) {
	for (const f of failures || []) {
		if (!f || !/^\s*(SELECT|WITH)\b/i.test(String(f.sql || ''))) continue;
		const kind = sqlRefusal(f.error);
		if (kind) return kind;
	}
	return null;
}
/**
 * The #836 answer: 500, no Retry-After (the same query is refused again), never cached, x-sql-refused names the
 * refusal. wrote says a write in the same request may have been kept: then the message is write-loss's "check before
 * you try again" and x-write-loss is unknown.
 */
export function refusedReadResponse(kind, json = false, wrote = false) {
	const headers = {
		'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		'x-sql-refused': String(kind),
		'x-write-loss': wrote ? 'unknown' : 'none',
	};
	const message = wrote ? WRITE_LOSS_MESSAGE : SQL_REFUSED_MESSAGE;
	const body = json ? JSON.stringify({ code: SQL_REFUSED_CODE, message, data: { status: 500, refused: String(kind) } }) : message + '\n';
	return { status: 500, headers, body };
}
/** Whether a /_frame answer PROVES the request kept nothing: rolled back, and no commit point passed. */
export function frameProvesRollback(frame) {
	return !!(frame && frame.state === 'rolled-back' && Number(frame.points) === 0);
}

/**
 * An API call gets JSON (the lead's ruling): a REST route or a client that asks for JSON.
 * The Store API checkout client then shows the message instead of failing to parse a text body.
 * Pretty permalinks use /wp-json/. Plain permalinks use /index.php/wp-json/ (#959).
 * A check that only starts with /wp-json/ misses that root.
 * Gutenberg's REST helper does not ask for JSON. The path has to match.
 */
function isRestPathname(pathname) {
	const path = String(pathname || '');
	const at = path.indexOf('/wp-json');
	if (at < 0) return false;
	const rest = path.slice(at + '/wp-json'.length);
	return rest === '' || rest.startsWith('/');
}
export function wantsJson(pathname, search, accept) {
	if (isRestPathname(pathname)) return true;
	if (/(^|[?&])rest_route=/.test(String(search || ''))) return true;
	return /application\/json/i.test(String(accept || ''));
}

/**
 * The answer for a request whose writes may be partly saved: status, headers, body. n is the
 * number of statements that failed in the reset, or 'unknown' when the reset killed the whole
 * request (the object answered nothing). kind is the reset (object-error.mjs): 'memory', or
 * 'storage' for a storage reset (#398). 'internal' is a platform fault (#1004): x-platform-error,
 * and no x-isolate-reset. No Retry-After, no Set-Cookie, never cached.
 *
 * phpStatus is PHP's own status on the write-loss log line (index.js), read before this
 * guard replaces the answer. It is not the status the client got: that is `answered`
 * (this status, or rolledBackResponse's). A phpStatus of 200 is still a lost write.
 */
export function writeLossResponse(n, json = false, kind = 'memory') {
	const headers = {
		'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		...lossKindHeaders(kind),
		'x-write-loss': String(n),
	};
	const body = json ? JSON.stringify({ code: WRITE_LOSS_CODE, message: WRITE_LOSS_MESSAGE, data: { status: 500 } }) : WRITE_LOSS_BODY;
	return { status: 500, headers, body };
}

/**
 * The mail a request collected, when the request's writes may be partly lost (#368, the lead's
 * ruling: HOLD). With lostWrites > 0 nothing is sent: the client gets the #353 500 ("check before
 * you try again"), so a mail must not confirm a change that may not be saved, and a client retry
 * must not send a second one. The cost, accepted: a change that WAS saved loses its mail. Each held
 * mail is one structured event (never silent); it names the subject and the recipient count, never
 * an address (Workers Logs is not a mail log). Returns { send: [...], events: [...] }.
 */
export function heldRequestMail(pending, lostWrites, req = {}) {
	const list = Array.isArray(pending) ? pending : [];
	if (!(Number(lostWrites) > 0)) return { send: list, events: [] };
	const events = list.map((e) => ({
		'@event': 'email-held',
		m: 'email-held',
		where: 'request',
		lostWrites: Number(lostWrites),
		method: req.method || null,
		path: req.path || null,
		subject: String((e && e.subject) || '').slice(0, 80),
		recipients: (Array.isArray(e && e.to) ? e.to : [e && e.to]).filter(Boolean).length,
	}));
	return { send: [], events };
}

/**
 * The verb and the table of a SQL statement, for a log line: never its values. A store's statements
 * can hold an email or an address, and Workers Logs is not a data store. "OTHER" when it is not one
 * of the verbs below (the binary form, an empty string).
 */
export function sqlShape(sql) {
	const m = /^\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b[\s\S]*?\b(?:FROM|INTO|UPDATE)?\s*`?([A-Za-z0-9_]+)`?/i.exec(String(sql || ''));
	if (!m) return 'OTHER';
	const verb = m[1].toUpperCase();
	let table = m[2];
	if (verb === 'SELECT') {
		const f = /\bFROM\s+`?([A-Za-z0-9_]+)`?/i.exec(String(sql));
		table = f ? f[1] : '?';
	} else if (verb === 'INSERT' || verb === 'REPLACE') {
		const i = /\bINTO\s+`?([A-Za-z0-9_]+)`?/i.exec(String(sql));
		table = i ? i[1] : table;
	} else if (verb === 'DELETE') {
		const f = /\bFROM\s+`?([A-Za-z0-9_]+)`?/i.exec(String(sql));
		table = f ? f[1] : table;
	} else if (verb === 'UPDATE') {
		const u = /^\s*UPDATE\s+`?([A-Za-z0-9_]+)`?/i.exec(String(sql));
		table = u ? u[1] : table;
	}
	return verb + ' ' + table;
}
