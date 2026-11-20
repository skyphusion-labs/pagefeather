// #1057 (the lead's ruling): a rejected wp_mail send is retried from the durable store we already have (the PHP
// object's storage), not a new Queue. One record per failed RECIPIENT (sendEmail sends one message per recipient):
//   - attempts counts the sends tried (the first send is 1); next is when the drain may try again;
//   - backoff after attempt n fails: BACKOFF_MS[n-1] (1, 5, 30 minutes, then hourly), at most MAX_ATTEMPTS sends;
//   - past the cap the record is DEAD-LETTERED: moved under DEAD_PREFIX (kept), one email-dead event, counted for
//     Site Health. A malformed record is dead-lettered at once, never retried forever.
// Each attempt is CLAIMED before its send (attempts and next written first), so a send that hangs or dies is not
// due again at once. A success deletes the record, so a later drain never sends it twice. The #370 dedupe stays where
// it is: a cron tick marks an Action Scheduler email handed off once; a failed handoff then retries only through
// here. The one window left: a send that succeeded in an isolate that died before its delete is sent once more.
export const RETRY_PREFIX = 'email-retry:';
export const DEAD_PREFIX = 'email-dead:';
const MIN = 60_000;
export const BACKOFF_MS = [1 * MIN, 5 * MIN, 30 * MIN, 60 * MIN, 60 * MIN, 60 * MIN];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
export const DRAIN_MAX = 25;

// FNV-1a, 64 bits as two 32-bit halves: a stable, address-free key for one message to one recipient.
function fnv(s, seed) {
	let h = seed >>> 0;
	for (const b of new TextEncoder().encode(s)) {
		h ^= b;
		h = Math.imul(h, 16777619) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}
export function retryKey(email, to) {
	const e = email || {};
	const id = JSON.stringify([String(to), String(e.subject || ''), String(e.message || ''), String(e.as_action || 0)]);
	return RETRY_PREFIX + fnv(id, 2166136261) + fnv(id, 0x9e3779b9);
}
const backoff = (n) => BACKOFF_MS[Math.min(Math.max(n, 1), BACKOFF_MS.length) - 1];

/** [key, record] pairs for the failures of a send: { email, to (the one recipient), error }. */
export function failureRecords(failures, now) {
	const out = [];
	for (const f of failures || []) {
		if (!f || !f.email || !f.to) continue;
		const email = { ...f.email, to: [String(f.to)] };
		out.push([retryKey(f.email, f.to), { email, attempts: 1, firstAt: now, next: now + backoff(1), lastError: String(f.error || '').slice(0, 160) }]);
	}
	return out;
}

const subjectOf = (rec) => String((rec && rec.email && rec.email.subject) || '').slice(0, 80);
const valid = (rec) => rec && rec.email && Array.isArray(rec.email.to) && rec.email.to.length === 1 && Number.isInteger(rec.attempts) && rec.attempts >= 1 && Number.isFinite(rec.next);

/**
 * One drain. storage: get-less KV with list({prefix}), put, delete. send(email): rejects on failure. Returns
 * { sent, failed, dead, next } (next: the earliest next-try left, for the alarm; null when none).
 */
export async function drainRetries({ storage, now, send, log = () => {}, max = DRAIN_MAX }) {
	const out = { sent: 0, failed: 0, dead: 0, next: null };
	const all = await storage.list({ prefix: RETRY_PREFIX });
	let n = 0;
	const keep = (t) => { if (out.next === null || t < out.next) out.next = t; };
	for (const [k, rec] of all) {
		const suffix = k.slice(RETRY_PREFIX.length);
		if (!valid(rec)) {
			await storage.put(DEAD_PREFIX + suffix, { rec, deadAt: now, reason: 'malformed' });
			await storage.delete(k);
			out.dead++;
			log({ '@event': 'email-dead', m: 'email-dead', reason: 'malformed', key: suffix });
			continue;
		}
		if (rec.next > now) { keep(rec.next); continue; }
		if (n >= max) { keep(now); continue; } // the next drain takes the rest
		n++;
		const attempt = rec.attempts + 1;
		const claimed = { ...rec, attempts: attempt, next: now + backoff(attempt) };
		await storage.put(k, claimed);
		try {
			await send(rec.email);
			await storage.delete(k);
			out.sent++;
			log({ m: 'email-retry', sent: 1, attempt, subject: subjectOf(rec) });
		} catch (e) {
			const err = String((e && e.message) || e).slice(0, 160);
			if (attempt >= MAX_ATTEMPTS) {
				await storage.put(DEAD_PREFIX + suffix, { ...claimed, lastError: err, deadAt: now, reason: 'cap' });
				await storage.delete(k);
				out.dead++;
				log({ '@event': 'email-dead', m: 'email-dead', reason: 'cap', attempts: attempt, subject: subjectOf(rec), error: err });
			} else {
				await storage.put(k, { ...claimed, lastError: err });
				out.failed++;
				keep(claimed.next);
				log({ m: 'email-retry', failed: 1, attempt, nextInMs: claimed.next - now, error: err });
			}
		}
	}
	return out;
}
