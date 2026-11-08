// Bound a promise with a timeout. Resolves to the promise's value when it settles
// within timeoutMs, otherwise to the TIMED_OUT sentinel. The timer is always
// cleared so a settled race never leaves a pending timeout holding the isolate.
//
// Used to cap how long the deferred-email drain may block two callers (#185, #198):
// the DO cron alarm, and a manual /_runcron. A send that env.EMAIL.send does not
// answer promptly (an undeliverable or throttled address) must not hold the caller
// until the DO wall-clock kills it, which would drop the whole cron record (#194).
// A send still in flight at the bound finishes best-effort, or the next alarm tick
// (and, with #190, the Queue) re-drives it; the alarm is the durable drain.
//
// The sentinel is a Symbol, not a value, so a legitimate resolution of 0 (zero
// emails sent) is never mistaken for a timeout.
export const TIMED_OUT = Symbol('promise-bound:timed-out');

export function boundedWait(promise, timeoutMs) {
	let timer;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
