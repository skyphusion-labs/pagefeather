// How much Action Scheduler work one cron tick may do (issue #291, measured 2026-11-12).
//
// The alarm is the only Action Scheduler runner. It used do_action('action_scheduler_run_queue'):
// the queue runner's run() loops batches until its time limit, runs the cleaner, and flushes the
// runtime cache after every batch, and its memory guard reads PHP's memory_limit (and
// memory_get_usage reads 0 in this PHP build), so nothing stopped it at the 128 MiB isolate.
// Local workerd, the 2609-product sample store, one tick, the PHP runtime's wasm memory after it:
//   no Action Scheduler at all                         99.4 MiB (a page view: 99.4)
//   run_queue, 1 action (any batch or time limit)     143.1 MiB (over the isolate on Cloudflare)
//   claim + process_action + release, 1 action        119.2 MiB
// So a tick now runs its own loop: stake_claim(CRON_AS_ACTIONS), process_action for each,
// release_claim, flushing the runtime cache after each (as the queue runner did per batch). The
// cleaner (reset_timeouts, mark_failures) runs on a tick that claimed nothing, and at least every
// CRON_CLEAN_MS on a busy store, so a long backlog cannot starve it. A backlog drains over ticks.
// What a tick claims (#357): first the woocommerce-emails group (WooCommerce's deferred order
// emails), NEWEST first; only when no email is due, everything else, oldest first. Oldest first for
// all put a new order email behind the whole backlog: about 3492 actions, about 85 h at the measured
// 41 an hour on the sample store (fdprobe1112j, 2026-11-12). Live on the same site, the first tick
// on this rule ran an order email that had waited 25 minutes, then the backlog's emails newest first.
// The batch stays 1: at CRON_AS_ACTIONS 4, 12 of 13 ticks reset the isolate.
export const DEFAULT_ACTIONS = 1;
// WP-Cron events per tick (the fixed 50 before). 0 skips WP-Cron in that tick.
export const DEFAULT_WP_EVENTS = 1;

const int = (v, lo, hi, dflt) => {
	const n = Number.parseInt(String(v ?? ''), 10);
	return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
};

/** The per-tick bound from env (CRON_AS_ACTIONS 1..100, CRON_WP_EVENTS 0..50); a bad value is the default. */
export function cronBounds(env) {
	return {
		actions: int(env && env.CRON_AS_ACTIONS, 1, 100, DEFAULT_ACTIONS),
		wpEvents: int(env && env.CRON_WP_EVENTS, 0, 50, DEFAULT_WP_EVENTS),
	};
}

// The cleaner runs at least this often even when every tick has work (the lead's condition: a
// 900-action backlog, about 3 h at 5 a tick, must still reset timed-out claims).
export const CLEAN_MS = 10 * 60 * 1000;
/** Is a cleaner run due by time? `last` is the stored time of the last clean (ms), or undefined. */
export function cronCleanDue(last, now, cleanMs = CLEAN_MS) {
	return !(Number(last) > 0) || now - Number(last) >= cleanMs;
}

// How often the cron leg runs (#470). The alarm also sends the coalesced page-cache purge, and a
// purge alarm is set PURGE_GAP_MS (15 s) after the last purge, so under admin writes the alarm ran
// every 15 s and each run booted WordPress for the cron leg, in the isolate that serves the admin
// (pft1a, 2026-11-13: cron ticks 15 to 30 s apart, then an alarm memory death). The leg now runs only
// when the last cron START is at least CRON_INTERVAL_MS ago. The start is stored before the run, so
// a run killed by an isolate reset still counts and the next purge alarm does not boot it again.
// CRON_SLACK_MS keeps the regular tick (armed CRON_INTERVAL_MS after the last one) from missing by
// a few ms of clock jitter.
export const CRON_SLACK_MS = 2000;
/** Is the cron leg due? `last` is the stored start of the last cron leg (ms), or undefined. */
export function cronLegDue(last, now, intervalMs, slackMs = CRON_SLACK_MS) {
	if (!(Number(last) > 0)) return true;
	if (Number(last) > now) return true; // a stored time from the future (a clock step): do not starve
	return now - Number(last) >= Math.max(0, Number(intervalMs) - slackMs);
}
