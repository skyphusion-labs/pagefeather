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

// Arm the NEXT tick before this one does any work (issue #291, measured 2026-11-12). An alarm
// whose run is killed (exceededMemory: the isolate is reset) or throws outside alarm()'s own
// try/catch never reaches the re-arm at its end. Each failure is then a platform retry, and once
// the retries are used up the object gets no alarm at all: on ggc.sh 7 throws at 19:14 to 19:17Z
// (1 run + 6 retries), then no alarm invocation for 8 hours; on ggc-test 10 alarm OOMs at
// 03:10 to 03:16Z. Arming first means a killed run still leaves a future alarm, so the cron never
// depends on the retry budget. sync() flushes the write, so a reset right after cannot drop it.
/** Set the next alarm at now + intervalMs and flush it, before the run. Returns the time set. */
export async function armBeforeRun(storage, now, intervalMs) {
	const at = now + intervalMs;
	await storage.setAlarm(at);
	if (typeof storage.sync === 'function') await storage.sync();
	return at;
}

// Unstick an object whose alarm is stale (issue #291). On ggc-test a fresh setAlarm over a stale
// alarm was not delivered (set 03:19:21Z by a fetch, no alarm invocation after it, 2026-11-12).
// So a stale alarm is DELETED first, then set again: the platform gets a new alarm, not an edit
// of the one whose retries are used up. No alarm: just set. A future or just-due alarm: untouched.
/** Arm when shouldArmAlarm says so; a stale alarm is deleted first. Returns what it did. */
export async function rearm(storage, now, intervalMs, staleMs = STALE_MS) {
	const at = await storage.getAlarm();
	if (!shouldArmAlarm(at, now, staleMs)) return { armed: false };
	const stale = at !== null && at !== undefined;
	if (stale) await storage.deleteAlarm();
	await storage.setAlarm(now + intervalMs);
	return { armed: true, stale, was: stale ? Number(at) : null };
}

// An alarm that throws spends the platform's retry budget (1 run + 6 retries), and an object that
// used it up got NO alarm afterwards, even after deleteAlarm + setAlarm and a new script version
// (fdprobe1112c, 2026-11-12: 7 scriptThrewException 04:08 to 04:11Z, then none). So alarm() never
// lets an error out: the next tick is already armed (armBeforeRun), the error is stored here for
// /_purgestate, and the alarm returns normally. ALARM_FATAL_KEY holds the last one.
export const ALARM_FATAL_KEY = 'alarm-fatal';
/** Store the error an alarm run threw (time, message, the top of the stack) and return it. */
export async function recordAlarmFatal(storage, e, now) {
	const rec = { t: now, error: String((e && e.message) || e).slice(0, 300), stack: String((e && e.stack) || '').slice(0, 1200) };
	const prev = (await storage.get(ALARM_FATAL_KEY)) || {};
	rec.count = (prev.count || 0) + 1;
	await storage.put(ALARM_FATAL_KEY, rec);
	return rec;
}
