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
// #1120: approach A's cron object (A_CRON) runs up to this many per leg, inside a time budget and a heap stop (cronMore).
// One a leg, at one leg a minute, left an order burst's 1,897 due emails about 31 h to drain (cf759hx, arm 3). Measured
// locally on a-shape-local with WooCommerce (2026-11-20), the PHP heap after a leg of order emails: 107 MiB at 1 and 5,
// 116 at 20, 121 at 40; 0.1 to 0.3 s an action. b-dosql keeps DEFAULT_ACTIONS: #323's resets were measured there.
export const DEFAULT_ACTIONS_A = 50;
// #1120: the wall time a leg spends on Action Scheduler before it stops claiming (CRON_AS_BUDGET_MS, 1 to 60 s). Well
// inside the PHP lock's 60 s stall bound (#1060) and the alarm's 5 min stale bound (alarm-arm.mjs).
export const AS_BUDGET_MS = 20000;
// #1120: the heap stop is ABSOLUTE, under the 128 MiB isolate (and Durable Object) wall: the engine's recycle line is
// 140 on lean (#1008: above the wall), so a stop derived from it alone would fire after exceededMemory. The stop is
// AS_HEAP_STOP_MIB, or AS_HEAP_MARGIN_MIB under the recycle line when that is lower.
export const AS_HEAP_STOP_MIB = 112;
export const AS_HEAP_MARGIN_MIB = 8;
/** #1120: the leg's heap stop in MiB, always under 128 whatever the recycle line. */
export function heapStopMib(lineMib) {
	const l = Number.isFinite(lineMib) ? lineMib - AS_HEAP_MARGIN_MIB : AS_HEAP_STOP_MIB;
	return Math.min(AS_HEAP_STOP_MIB, l);
}
// WP-Cron events per tick (the fixed 50 before). 0 skips WP-Cron in that tick.
export const DEFAULT_WP_EVENTS = 1;

const int = (v, lo, hi, dflt) => {
	const n = Number.parseInt(String(v ?? ''), 10);
	return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
};

/** The per-tick bound from env (CRON_AS_ACTIONS 1..100, CRON_WP_EVENTS 0..50); a bad value is the default.
 * approachA (#1120): A's cron object, whose default is DEFAULT_ACTIONS_A. */
export function cronBounds(env, { approachA = false } = {}) {
	return {
		actions: int(env && env.CRON_AS_ACTIONS, 1, 100, approachA ? DEFAULT_ACTIONS_A : DEFAULT_ACTIONS),
		wpEvents: int(env && env.CRON_WP_EVENTS, 0, 50, DEFAULT_WP_EVENTS),
	};
}

/** #1120: the leg's Action Scheduler budget from env (CRON_AS_BUDGET_MS 1000..60000); a bad value is the default. */
export function cronAsBudgetMs(env) {
	const v = env && env.CRON_AS_BUDGET_MS;
	return /^[0-9]{4,5}$/.test(String(v ?? '')) ? int(v, 1000, 60000, AS_BUDGET_MS) : AS_BUDGET_MS;
}

// #1120: the gap before the next leg when a leg on A's cron object was cut short with Action Scheduler work still due
// (CRON_BACKLOG_GAP_MS, 1 to 60 s). The full CRON_INTERVAL_MS (60 s) between budget-stopped legs left a burst draining
// at one leg a minute.
export const BACKLOG_GAP_MS = 5000;
/** #1120: the backlog gap from env (CRON_BACKLOG_GAP_MS 1000..60000); a bad value is the default. */
export function cronBacklogGapMs(env) {
	const v = env && env.CRON_BACKLOG_GAP_MS;
	return /^[0-9]{4,5}$/.test(String(v ?? '')) ? int(v, 1000, 60000, BACKLOG_GAP_MS) : BACKLOG_GAP_MS;
}
/** #1120: ms until the next leg when this one made progress and work is still due, or null (the usual interval). Only on
 * A's cron object (b-dosql keeps the interval, #470). Progress: the leg ran at least one action (stopped for budget or
 * heap, ran its cap, or its email pass ran out with other work due: a leg runs the other actions only when no email is
 * due). A leg that ran nothing (a stuck claim) or had no bridge ('stop') keeps the interval, so it can never spin. */
export function cronBacklogNext({ approachA, asDue, asStop, asActions, gapMs }) {
	if (!approachA || !(Number(asDue) > 0) || !(Number(asActions) > 0) || asStop === 'stop') return null;
	return gapMs;
}
/** #1120: is a backlog leg due? `at` is the stored backlog mark (the end of the cut-short leg, ms), or undefined. */
export function cronBacklogDue(at, now, gapMs, slackMs = CRON_SLACK_MS) {
	return Number(at) > 0 && now - Number(at) >= gapMs - slackMs;
}

/** #1120: may the leg run another action? null = yes; 'budget' or 'heap' = stop, and why. n = actions already run (the
 * first always runs, as before #1120); heapMib = the PHP heap now; startHeapMib = the heap when the leg began; lineMib =
 * the engine's recycle line. WebAssembly memory never shrinks and the cron runtime is not recycled (#598), so the heap
 * is a high-water mark: a leg stops when THIS leg grew it to or past the stop. A runtime already past the stop that
 * reuses its memory grows nothing and goes on; the heap is then bounded by the stop plus one action's growth. An
 * unreadable heap stops (fails closed). */
export function cronMore({ n, startedAt, now, budgetMs, heapMib, startHeapMib, lineMib }) {
	if (!(n > 0)) return null;
	if (now - startedAt >= budgetMs) return 'budget';
	if (!Number.isFinite(heapMib) || !Number.isFinite(startHeapMib)) return 'heap';
	if (heapMib >= heapStopMib(lineMib) && heapMib > startHeapMib) return 'heap';
	return null;
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
