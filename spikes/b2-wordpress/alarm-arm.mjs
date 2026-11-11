// When a request should (re)arm the site object's alarm (issue #291).
//
// The alarm is the ONLY runner of Action Scheduler and WP-Cron on b-dosql, and it also sends
// the coalesced page-cache purge. A request arms it only when there is none. But an alarm whose
// handler never completes (an isolate killed mid-run, every retry used up) can leave its time
// behind: storage.getAlarm() still returns it, long past. Measured on ggc.sh on 2026-11-11:
// getAlarm() returned 19:14:26Z at 21:15Z. Then "only when there is none" never arms again, and
// the cron stops for good, with nothing to say so outside /_purgestate.
//
// So an alarm more than STALE_MS in the past counts as none. A due alarm (just past, about to
// run) is left alone, so a request never pushes back a purge or cron tick that is about to fire.
export const STALE_MS = 5 * 60 * 1000;

/** Should a request set a new alarm? `at` is storage.getAlarm() (null when none). */
export function shouldArmAlarm(at, now, staleMs = STALE_MS) {
	if (at === null || at === undefined) return true;
	return Number(at) < now - staleMs;
}
