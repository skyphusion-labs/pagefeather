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
