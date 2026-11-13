// A cron leg that keeps dying (#471). On pft1a (2026-11-13) every alarm tick from 21:49Z died
// (isolate memory, or PHP exit 255), the alarm re-fired every minute, and each death took the
// isolate with it: requests then booted cold and their writes failed. Nothing in the run said
// which job died: the exit-255 log held only the first bytes of WordPress's error page.
//
// The run record (CRON_RUN_KEY, in the object's storage): {startedAt, done, deaths, lastMark,
// lastFatal}. It is written, and synced, BEFORE PHP runs, and marked done after. A leg that starts
// while the previous one never finished counts that one as a death; a finished leg resets the
// count. From BACKOFF_FROM consecutive deaths, the leg waits cronBackoffMs before it tries again
// (the purge still goes out). lastMark is the job the run had started last (a cronMark message
// PHP sends BEFORE each job); lastFatal is PHP's own error (a cronFatal message from a shutdown
// function). Both are also logged at once, so a run the isolate kills still leaves them.

export const CRON_RUN_KEY = 'cron-run';
export const BACKOFF_FROM = 2;
export const BACKOFF_BASE_MS = 60 * 1000;
export const BACKOFF_MAX_MS = 60 * 60 * 1000;

/** The wait after `deaths` consecutive deaths: 0 below BACKOFF_FROM, then 2, 4, 8 ... minutes, at most 60. */
export function cronBackoffMs(deaths) {
	const d = Number(deaths) || 0;
	if (d < BACKOFF_FROM) return 0;
	return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (d - 1));
}

// The deaths counted if a leg started now: the stored count, plus one when the last run never finished.
function pendingDeaths(prev) {
	if (!prev || !(Number(prev.startedAt) > 0)) return 0;
	return prev.done ? 0 : (Number(prev.deaths) || 0) + 1;
}

/** Must this leg wait? {waitMs, deaths}: waitMs 0 means it may run. */
export function cronBackoff(prev, now) {
	const deaths = pendingDeaths(prev);
	const ms = cronBackoffMs(deaths);
	if (!ms) return { waitMs: 0, deaths };
	const left = Number(prev.startedAt) + ms - now;
	return { waitMs: left > 0 ? left : 0, deaths };
}

/** The record to store as a leg starts. died: the previous run never finished. */
export function cronRunStart(prev, now) {
	const deaths = pendingDeaths(prev);
	const died = !!prev && Number(prev.startedAt) > 0 && !prev.done;
	return {
		died,
		rec: {
			startedAt: now,
			done: false,
			deaths,
			lastMark: null,
			lastFatal: null,
			// What the run that died had started, and PHP's error if it had one, kept for /_purgestate.
			prevMark: died ? prev.lastMark || null : null,
			prevFatal: died ? prev.lastFatal || null : null,
		},
	};
}

/** The record once the leg finished. */
export function cronRunDone(rec, now) {
	return { ...(rec || {}), done: true, doneAt: now, deaths: 0 };
}

const clip = (v, n) => String(v ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, n);

/** A cronMark message from PHP, cleaned: kind as or wp, a hook name, an action id. */
export function cronMarkOf(m) {
	const o = m && typeof m === 'object' ? m : {};
	return {
		k: o.k === 'as' || o.k === 'wp' ? o.k : '?',
		hook: clip(o.hook, 120).replace(/[^A-Za-z0-9_.:\/-]/g, '') || '?',
		id: Number.isSafeInteger(o.id) && o.id >= 0 ? o.id : 0,
	};
}

/** A cronFatal message from PHP, cleaned and bounded: the message, the file under the docroot, the line. */
export function cronFatalOf(f) {
	const o = f && typeof f === 'object' ? f : {};
	return {
		type: Number.isSafeInteger(o.type) ? o.type : 0,
		msg: clip(o.msg, 300),
		file: clip(o.file, 160).replace(/^\/wordpress\//, ''),
		line: Number.isSafeInteger(o.line) ? o.line : 0,
	};
}
