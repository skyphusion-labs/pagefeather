// #730 (#589 B): the operator-only post-INSERT fault injector. A MEASUREMENT for throwaway sites only.
//
// #589's decision needs the rolled-back share of REST writes killed AFTER their write, and natural memory kills
// land before the INSERT (run6b, run7, run7c: 0, 0 and 3 post-write kills against a floor of 20). With this, a
// chosen request is killed right after its INSERT into wp_posts commits, so every injected kill is post-write.
//
// Armed only when ALL hold (faultArmed): the site var FAULT_INJECT is "after-insert" (rendered only with
// THROWAWAY=1 and never for a live site, deploy/fault-inject.sh, in both emitters), the request carries the
// spike token, and it sends x-pf-fault: after-insert. index.js arms it per object request and fires it once, in
// sqlStatement, after the statement (and the frame's opening transaction) returned.
//
// The kill is the NATURAL one: allocate and touch memory, holding every chunk, until the platform resets the
// isolate (outcome exceededMemory), the way /_headroom ends an isolate (headroom.mjs). Not a PHP error and not a
// JS throw, so the platform's own reset path runs: the gateway's x-isolate-reset: memory, the write-loss 500, the
// next isolate's recover(), the /_frame probe. If the isolate is still alive at the cap, the caller logs
// fault-not-killed and the request goes on; the measurement then counts it as answered, never as a kill.

export const FAULT_HEADER = 'x-pf-fault';
export const FAULT_AFTER_INSERT = 'after-insert';

// #766: the SQL statement failure, a MEASUREMENT for throwaway and local sites only, under the same rule (the site var
// FAULT_INJECT is "sql-fail", deploy/fault-inject.sh; the spike token; x-pf-fault: sql-fail). x-pf-fault-sql names a
// piece of the statement to fail: the FIRST statement of the request containing it throws the platform's own message,
// once. So everything after it (noteFailure, resetFailures, the write-loss answer, the ledger's sql-memory-fail) runs
// as for a real failure at the memory ceiling, and the isolate is NOT killed: in #724 the object went on after such
// a failure.
export const FAULT_SQL_FAIL = 'sql-fail';
export const FAULT_SQL_HEADER = 'x-pf-fault-sql';
export const SQL_FAIL_MESSAGE = "Durable Object's isolate exceeded its memory limit and was reset.";
// x-pf-fault-sql-kind: other throws a NON-reset error instead (#770 review: any other SQLite failure), which the
// write-loss answer does not replace, so PHP answers with what it saw.
export const FAULT_SQL_KIND_HEADER = 'x-pf-fault-sql-kind';
export const SQL_FAIL_OTHER_MESSAGE = 'SQLITE_ERROR: injected statement failure (#766, a measurement)';
// #795: busy is a platform failure that is not the reset (the database busy), the class that gets a retryable answer;
// other is a deterministic statement error, which goes back to WordPress as MySQL's would.
export const SQL_FAIL_BUSY_MESSAGE = 'SQLITE_BUSY: database is locked (injected, #795, a measurement)';
/** The message the armed statement throws: the platform's reset (the default), busy, or a deterministic error. */
export function sqlFailMessage(headers) {
	const k = headers ? headers.get(FAULT_SQL_KIND_HEADER) : null;
	return k === 'other' ? SQL_FAIL_OTHER_MESSAGE : k === 'busy' ? SQL_FAIL_BUSY_MESSAGE : SQL_FAIL_MESSAGE;
}

// #809: the UNDO failure, a MEASUREMENT for throwaway and local sites only, under the same rule as sql-fail (the site var
// FAULT_INJECT is "sql-fail", the spike token, x-pf-fault: sql-fail). x-pf-fault-undo: on makes every frame rollback and
// recovery undo (undo-log.mjs undoTo, inside its transaction, after its statements) throw the platform's reset, so a
// frame strands as it would when its undo meets the same storage ceiling; off ends it. It holds across requests
// (module state of the object), so a following request and the cron alarm meet the stranded frame. index.js reads it
// BEFORE the request's recovery, so the request that turns it off is the one whose recovery succeeds.
export const FAULT_UNDO_HEADER = 'x-pf-fault-undo';
export const UNDO_FAIL_MESSAGE = "Durable Object's isolate exceeded its memory limit and was reset. (injected into the undo, #809, a measurement)";
/** true (on), false (off), or null (no change): the site var, the spike token, x-pf-fault: sql-fail, and on or off. */
export function undoFailSet(env, spikeOk, headers) {
	if (!env || env.FAULT_INJECT !== FAULT_SQL_FAIL || spikeOk !== true || !headers || headers.get(FAULT_HEADER) !== FAULT_SQL_FAIL) return null;
	const v = headers.get(FAULT_UNDO_HEADER);
	return v === 'on' ? true : v === 'off' ? false : null;
}

/** The piece of SQL to fail in this request, or null: the site var, the spike token, the header, and 3 to 120 characters. */
export function sqlFailNeedle(env, spikeOk, headers) {
	if (!env || env.FAULT_INJECT !== FAULT_SQL_FAIL || spikeOk !== true || !headers || headers.get(FAULT_HEADER) !== FAULT_SQL_FAIL) return null;
	const n = String(headers.get(FAULT_SQL_HEADER) || '');
	return n.length >= 3 && n.length <= 120 ? n : null;
}

/** True only with the site var, the spike token (the boolean from the object's own check) and the header. */
export function faultArmed(env, spikeOk, headers) {
	return Boolean(env) && env.FAULT_INJECT === FAULT_AFTER_INSERT && spikeOk === true && Boolean(headers) && headers.get(FAULT_HEADER) === FAULT_AFTER_INSERT;
}

const TARGET = /^\s*INSERT\s+INTO\s+[`"]?wp_posts[`"]?\s*\(/i;
/** The request's INSERT into wp_posts (the page or post itself) that changed a row. */
export function isFaultTarget(sql, reply) {
	return TARGET.test(String(sql || '')) && Boolean(reply) && reply.ok === true && Number(reply.changes) > 0;
}

/**
 * Allocate chunkMiB buffers, touch each, hold each in `held`, until capMiB. A RangeError (one allocation refused)
 * is counted and the loop goes on: only the platform's reset may end it. Returns { killed: false, mib, throws }
 * when the isolate is still alive at the cap (in a test, or if the platform did not reset it).
 */
export function exhaustMemory({ alloc = (n) => new ArrayBuffer(n), held = [], capMiB = 4096, chunkMiB = 4 } = {}) {
	let mib = 0;
	let throws = 0;
	while (mib < capMiB) {
		try {
			const b = alloc(chunkMiB * 1048576);
			new Uint8Array(b).fill(1);
			held.push(b);
			mib += chunkMiB;
		} catch {
			throws++;
			if (throws > 64) break;
		}
	}
	return { killed: false, mib, throws };
}

// #1057: the EMAIL rejection, a MEASUREMENT for throwaway and local sites only, under the same rule (the site var
// FAULT_INJECT is set, which deploys render only for a throwaway, deploy/fault-inject.sh). EMAIL_FAULT=reject-N makes the
// first N env.EMAIL.send calls of THIS ISOLATE reject, so the retry path (email-retry.mjs) runs as for a real refusal.
// The count lives in this module, so it is per isolate, not per site: the cron object and any fresh isolate each
// reject their own first N (measured on cf759hx, 2026-11-20).
let emailRejectsLeft = null;
/** True when this send must reject (and counts it): the site var FAULT_INJECT, and EMAIL_FAULT=reject-N. */
export function emailFaultRejects(env) {
	if (!env || !env.FAULT_INJECT || typeof env.EMAIL_FAULT !== 'string') return false;
	const m = /^reject-(\d{1,3})$/.exec(env.EMAIL_FAULT);
	if (!m) return false;
	if (emailRejectsLeft === null) emailRejectsLeft = Number(m[1]);
	if (emailRejectsLeft <= 0) return false;
	emailRejectsLeft--;
	return true;
}
