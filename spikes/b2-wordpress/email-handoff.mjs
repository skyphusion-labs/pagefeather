// A cron tick hands each order email to the durable path from inside the op (#362).
//
// Before: wp_mail in a cron tick only pushed the message onto the in-memory pendingEmails, and the
// alarm sent the list after runCron returned. An isolate memory reset that killed the alarm after
// an email action had run lost that mail: the action's writes (status complete) were durable, the
// list in memory was not, and nothing retried it (path A).
//
// Now: the op hands the message off (the email queue, or env.EMAIL.send when the queue is off) and
// waits for the handoff before PHP goes on. A reset after the op can no longer lose it.
//
// The duplicate side (path B). A reset hits mid-tick, every later statement fails, and PHP keeps
// running. Two cases, decided by where the mail comes from:
//
// - Inside an Action Scheduler action (WooCommerce's deferred order emails). Action Scheduler runs
//   the action only after log_execution has set it in-progress, and log_execution throws when its
//   UPDATE fails (ActionScheduler_DBStore::log_execution, WooCommerce 11.2.1; a failed statement
//   is a PDOException in d1-pdo.php and a false from wpdb). So a mail from inside an action means
//   the in-progress write LANDED. Such an action is never picked again: the tick's stale-claim
//   release touches only pending actions, and the cleaner later marks an in-progress one failed.
//   Sending it is the only send it gets. Holding it would lose it. So it is always handed off.
//   The action id goes with the message as its dedupe key.
// - Inside a WP-Cron event of the tick. runCron unschedules the event (and reschedules a recurring
//   one) before it runs it, and tags the mail with whether those writes were saved (wp_cron 1) or
//   not (wp_cron -1). Saved: the event does not run again, so the mail is handed off. Not saved:
//   the event runs again on a later tick, so the mail is held (not sent) and that run sends it.
// - Anywhere else (plugin code that runs while WordPress loads). The tick cannot tell whether the
//   state change behind the mail was saved. After a reset in this tick the mail is held, as the
//   #353 request guard refuses a request with lost writes. Before any reset it is handed off.
//
// The dedupe key is ENFORCED at the handoff (#370). Before #370 it was only carried. A message from an
// Action Scheduler action gets a key from the action id plus a hash of its recipients and subject:
// one action sends more than one mail (pending_to_processing sends the admin new-order mail AND the
// customer processing mail, measured on fdprobe1113a), so the action id alone would drop the second
// one. Before a handoff, the op asks seen(key); a key already marked is not sent again. After a
// handoff, mark(key) records it in the PHP object's durable storage. A storage error never stops a
// send (seen fails: send; mark fails: the mail has left): losing an order email is worse than a rare
// duplicate. This is what makes a retry of an email action safe (#367). A mail with no action id
// (WP-Cron, plugin code) has no key and is never deduped.
//
// These helpers are the pure, unit-tested core; the env and PHP glue lives in index.js.

export const HANDOFF = 'handoff';
export const HOLD = 'hold';

/** The Action Scheduler action a wp_mail message came from (wp-mail-queue.php), or 0. */
export function emailActionId(email) {
	const n = Math.floor(Number(email && email.as_action) || 0);
	return n > 0 ? n : 0;
}

export const DEDUPE_PREFIX = 'mail-sent:';

/**
 * The dedupe key of a wp_mail message: mail-sent:<action id>:<16 hex of SHA-256 of the sorted
 * recipients and the subject>, or null when it has no action id. Async (crypto.subtle).
 */
export async function emailDedupeKey(email) {
	const id = emailActionId(email);
	if (!id) return null;
	const to = (Array.isArray(email.to) ? email.to : [email.to]).map((t) => String(t || '').trim().toLowerCase()).filter(Boolean).sort();
	const data = new TextEncoder().encode(to.join(',') + '\n' + String(email.subject || ''));
	const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
	return DEDUPE_PREFIX + id + ':' + Array.from(h.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * What a cron tick does with one wp_mail message. lostWrites is the number of statements this
 * tick has lost to an isolate memory reset so far (write-loss.mjs resetFailures).
 */
export function tickEmailDecision(email, lostWrites) {
	if (emailActionId(email)) return HANDOFF;
	const wpCron = Number(email && email.wp_cron) || 0;
	if (wpCron > 0) return HANDOFF;
	if (wpCron < 0) return HOLD;
	return Number(lostWrites) > 0 ? HOLD : HANDOFF;
}

/**
 * The mail side of one cron tick.
 *   handoff(email)  resolves once the message is with the durable path (queued, or sent). It may
 *                   resolve to the string 'bounded' when the send was still in flight at its bound.
 *   lostWrites()    the reset failures this tick has seen so far.
 *   log(obj)        one structured line per decision.
 *   seen(key)       optional: resolves true when that key was already handed off (#370).
 *   mark(key)       optional: records that the key was handed off.
 * op(email) is what the email op returns to PHP while the tick runs. lostWritesSeen() is for the
 * tick record.
 */
export function createTickMail({ handoff, lostWrites, log = () => {}, seen = null, mark = null }) {
	const counts = { handedOff: 0, held: 0, failed: 0, bounded: 0, deduped: 0 };
	return {
		counts,
		lostWritesSeen: () => Number(lostWrites()) || 0,
		async op(email) {
			const lost = Number(lostWrites()) || 0;
			const as_action = emailActionId(email) || null;
			if (tickEmailDecision(email, lost) === HOLD) {
				counts.held++;
				log({ '@event': 'email-held', m: 'email-held', lostWrites: lost, wp_cron: Number(email && email.wp_cron) || 0, subject: String((email && email.subject) || '').slice(0, 80) });
				return { ok: true, queued: false, held: true };
			}
			const key = seen || mark ? await emailDedupeKey(email) : null;
			if (key && seen) {
				let was = false;
				try {
					was = !!(await seen(key));
				} catch (e) {
					log({ '@event': 'email-dedupe', m: 'email-dedupe', as_action, error: 'seen: ' + String((e && e.message) || e).slice(0, 120), sent: 'anyway' });
				}
				if (was) {
					counts.deduped++;
					log({ '@event': 'email-deduped', m: 'email-deduped', as_action, key });
					return { ok: true, queued: false, deduped: true };
				}
			}
			try {
				const r = await handoff(email);
				if (r === 'bounded') counts.bounded++;
				counts.handedOff++;
				if (key && mark) {
					try {
						await mark(key);
					} catch (e) {
						log({ '@event': 'email-dedupe', m: 'email-dedupe', as_action, error: 'mark: ' + String((e && e.message) || e).slice(0, 120) });
					}
				}
				log({ '@event': 'email-handoff', m: 'email-handoff', as_action, lostWrites: lost, ...(r === 'bounded' ? { bounded: true } : {}) });
				return { ok: true, queued: true };
			} catch (e) {
				counts.failed++;
				const error = String((e && e.message) || e).slice(0, 200);
				log({ '@event': 'email-handoff', m: 'email-handoff', as_action, failed: true, error });
				return { ok: false, error };
			}
		},
	};
}
