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
// These helpers are the pure, unit-tested core; the env and PHP glue lives in index.js.

export const HANDOFF = 'handoff';
export const HOLD = 'hold';

/** The Action Scheduler action a wp_mail message came from (wp-mail-queue.php), or 0. */
export function emailActionId(email) {
	const n = Math.floor(Number(email && email.as_action) || 0);
	return n > 0 ? n : 0;
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
 * op(email) is what the email op returns to PHP while the tick runs. lostWritesSeen() is for the
 * tick record.
 */
export function createTickMail({ handoff, lostWrites, log = () => {} }) {
	const counts = { handedOff: 0, held: 0, failed: 0, bounded: 0 };
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
			try {
				const r = await handoff(email);
				if (r === 'bounded') counts.bounded++;
				counts.handedOff++;
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
