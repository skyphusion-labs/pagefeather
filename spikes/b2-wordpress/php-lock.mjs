// The one-at-a-time PHP lock of an isolate (#296 step 1.1). index.js withPhp runs every PHP run through it.
//
// One PHP runtime per isolate, and PHP is not re-entrant, so runs go one at a time.
// Equal priority stays arrival order. A higher priority is granted before an earlier
// lower one that is still waiting (#962). A run that has started is never stopped.
// Before this, a waiter that had WAITED LOCK_STALE_MS (60 s) took the lock as stale, dropped the runtime
// and booted a new one, while the run ahead was still executing and holding its heap. Under concurrent
// checkout on approach A that is the normal case, not a stuck one: Cloudflare keeps sending requests to
// an isolate whose run is waiting on MySQL, the queue grows, a waiter passes 60 s, a second heap boots
// beside the live one, the isolate passes its memory limit, and every request queued on it dies
// (measured 2026-11-15, #296 step 0: 80 exceededMemory with CPU p50 0.22 ms and wall p50 51 s).
//
// Now:
//   stale  only when the run AHEAD has itself been executing staleMs: the stuck case the rule was for
//          (a Free-tier CPU kill can leave a run that never ends; measured 2026-11-04). A long queue of
//          healthy runs never boots a second runtime.
//   shed   a waiter with shedMs > 0 that has waited shedMs answers PHP_SHED at once instead of waiting
//          on (at: wait, by its timer), or when its turn comes past the bound (at: grant: a PHP run that
//          does not yield lets no timer fire): the caller sends a fast 503 with Retry-After. Its place in the order passes on: the
//          waiter behind it still waits for the run ahead, so two runs never overlap.
//   log    { event: queued | granted | shed | stale | released, depth, waitMs, headMs }: queued when a run arrives
//          behind another, granted when it waited 1 s or more, and every shed and stale. An
//          uncontended run logs nothing. released (#1101: ranMs, outcome ok or threw) ends every contended run, and
//          any run that ran GRANT_LOG_MS or more, so a load run can show that every grant ended.
//   #1060  (measured on cf759hl, 2026-11-20: a head ran 60 s, the stale waiter booted a second runtime beside the live
//          one, and the isolate died of memory with every queued request). With stallMs, a head is stale only when it
//          has ALSO made no progress (progress(): index.js calls it on every PHP bridge message) for stallMs: a slow run
//          that is still working is never stale. staleAction per run: take (the old takeover, onStale), shed (the
//          request paths: the waiter answers PHP_SHED, why stuck, a retryable 503), or wait (background runs: keep
//          waiting for the head). index.js never takes over: a second runtime beside a live one is a certain reset.
// Pure and clock-injected, so tests/php-lock.test.mjs drives it on a fake clock.

export const PHP_SHED = Symbol('php-shed');
const TICK_MS = 1000;
const GRANT_LOG_MS = 1000;

export function createPhpLock({ staleMs = 60000, stallMs = null, staleAction: defaultStaleAction = 'take', now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} } = {}) {
	let lastProgress = null; // #1060: the head's last bridge message (or its start)
	let waiting = 0;
	let running = 0;
	let blocking = 0; // runs that still own the queue. A stale takeover clears the stuck run.
	let headSince = null; // when the newest executing run started; null when none executes
	let headState = null;
	let seq = 0;
	const waiters = []; // { seq, priority, go, state }
	const headMs = () => (headSince === null ? 0 : now() - headSince);
	// #1060: the head counts as stale only past staleMs AND, with stallMs, with no progress for stallMs.
	const headStale = () => headSince !== null && headMs() >= staleMs && (stallMs === null || lastProgress === null || now() - lastProgress >= stallMs);

	function bestIndex() {
		let best = 0;
		for (let i = 1; i < waiters.length; i++) {
			const a = waiters[i];
			const b = waiters[best];
			if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
		}
		return best;
	}
	function pump() {
		if (blocking > 0 || waiters.length === 0) return;
		const item = waiters.splice(bestIndex(), 1)[0];
		// #1101: the grant takes the slot HERE, synchronously. The waiter's continuation runs later (on workerd, through its
		// own request context when the grant came from another), and before this an arrival in that gap saw blocking 0 and a
		// non-empty queue and pumped a SECOND waiter: two runs at once (cf759hx arm 3, granted 1 ms apart, one hung).
		item.reserved = true;
		blocking++;
		item.go();
	}
	function drop(item) {
		const i = waiters.indexOf(item);
		if (i >= 0) waiters.splice(i, 1);
	}

	// Resolves 'turn' when prev settles, 'stale' when the run ahead has executed staleMs, 'shed' at shedMs, and 'gone'
	// when signal aborts (#721: the caller disconnected; it needs enable_request_signal).
	function waitTurn(prev, t0, shedMs, signal, staleAction) {
		return new Promise((resolve) => {
			let timer = null;
			let done = false;
			const onAbort = () => finish('gone');
			const finish = (why) => {
				if (done) return;
				done = true;
				if (timer !== null) clearTimer(timer);
				if (signal) signal.removeEventListener('abort', onAbort);
				resolve(why);
			};
			if (signal) signal.addEventListener('abort', onAbort, { once: true });
			prev.then(() => finish('turn'), () => finish('turn'));
			const check = () => {
				timer = null;
				if (done) return;
				// #708 review 1: SHED first. A waiter past its bound never runs, even if the head has also run past the stale
				// time: with the default start-by (60 s) equal to LOCK_STALE_MS, both can fall due at the one check.
				if (shedMs > 0 && now() - t0 >= shedMs) return finish('shed');
				if (staleAction !== 'wait' && headStale()) return finish('stale');
				let next = TICK_MS;
				if (shedMs > 0) next = Math.min(next, Math.max(1, t0 + shedMs - now()));
				if (headSince !== null && staleAction !== 'wait') next = Math.min(next, Math.max(1, headSince + staleMs - now()));
				timer = setTimer(check, next);
			};
			// The first check after the promise settles in the same tick would be wasted: wait one tick.
			timer = setTimer(check, Math.min(TICK_MS, shedMs > 0 ? shedMs : TICK_MS));
		});
	}

	return {
		get waiting() { return waiting; },
		get running() { return running; },
		/** #1060: the running PHP run made progress (a bridge message): it is slow, not stuck. */
		progress() { if (headSince !== null) lastProgress = now(); },
		// run(fn, { shedMs, onStale, tag, priority }): fn's result, or PHP_SHED. onStale runs before fn when the lock was
		// taken as stale (index.js drops the runtime there). tag (#708) is added to this run's log lines (the
		// correlation id of the forwarded request), so a queued, granted or shed line names its request.
		// shedWhy (#715 review2 8) names the bound on a shed line: start-by, or the operator's queue-shed.
		// recheck (#715 review3 5): an async start-by check at a contended grant (the clock may be stale there,
		// start-by.mjs recheckStartBy). { late: true } sheds before any grant line: at: clock, why: start-by.
		// signal (#721): the caller's request.signal. A waiter whose caller disconnected sheds (why: disconnect) and never
		// runs: on arrival, while it waits, or at its grant. A run that has started is never stopped by it.
		// priority (#962): higher runs before an earlier lower waiter. Default 0 is arrival order.
		run(fn, { shedMs = 0, onStale = () => {}, tag = null, shedWhy = null, recheck = null, signal = null, priority = 0, staleAction = defaultStaleAction } = {}) {
			const lg = tag ? (e) => log({ ...e, ...tag }) : log;
			if (signal && signal.aborted) {
				// Gone before it queued: it takes no place in the order.
				lg({ event: 'shed', at: 'arrive', waitMs: 0, depth: waiting + running, headMs: headMs(), why: 'disconnect' });
				return Promise.resolve(PHP_SHED);
			}
			const t0 = now();
			const state = { superseded: false };
			const contended = blocking > 0 || waiters.length > 0;
			if (contended) lg({ event: 'queued', depth: waiting + running, headMs: headMs() });
			waiting++;
			let go;
			const granted = new Promise((r) => { go = r; });
			const item = { seq: seq++, priority, go, state };
			waiters.push(item);
			if (blocking === 0) pump();
			const took = !waiters.includes(item);
			return (async () => {
				let why = took ? 'turn' : await waitTurn(granted, t0, shedMs, signal, staleAction);
				waiting--;
				const waitMs = now() - t0;
				// #1060: a stale head on a shed path: answer at once, never take over (a second runtime beside a live one).
				if (why === 'stale' && staleAction === 'shed' && waiters.includes(item)) {
					drop(item);
					lg({ event: 'shed', at: 'stale', waitMs, depth: waiting + running, headMs: headMs(), why: 'stuck', sinceProgressMs: lastProgress === null ? null : now() - lastProgress });
					return PHP_SHED;
				}
				// Still in the queue: the timer shed, or the caller left, before a grant.
				if ((why === 'shed' || why === 'gone') && waiters.includes(item)) {
					drop(item);
					const whyShed = why === 'gone' ? 'disconnect' : shedWhy;
					lg({ event: 'shed', at: 'wait', waitMs, depth: waiting + running, headMs: headMs(), ...(whyShed ? { why: whyShed } : {}) });
					return PHP_SHED;
				}
				if (waiters.includes(item)) drop(item);
				// Own the slot before any await, so a new arrival cannot start beside this grant. A grant from pump() already
				// took it (#1101); a waiter that goes on without a grant (a stale takeover) takes it now.
				const prevHead = headState;
				if (!item.reserved) blocking++;
				item.reserved = false;
				headState = state;
				// The grant-time check: a run that does not yield lets no waiter timer fire, and when it ends
				// this turn (a microtask) beats the overdue timer. Measured on local workerd (b-do): without
				// this, waits of 2.7 s were granted against a 1 s bound. A waiter over its bound sheds here.
				let at = 'wait';
				// #721: a caller that disconnected while this waited, or is gone at the grant: shed, never run.
				let disconnect = false;
				if (why === 'gone') {
					why = 'shed';
					disconnect = true;
				} else if ((why === 'turn' || why === 'stale') && signal && signal.aborted) {
					at = 'grant';
					why = 'shed';
					disconnect = true;
				}
				// #708 review 1: the stale path too. A waiter taken as stale after its bound would otherwise drop the runtime
				// and RUN fn after its caller was answered; it sheds instead, and never runs.
				if ((why === 'turn' || why === 'stale') && shedMs > 0 && waitMs >= shedMs) {
					at = why === 'stale' ? 'stale' : 'grant';
					why = 'shed';
				}
				let clock = null;
				if (why !== 'shed' && contended && recheck) {
					clock = await recheck();
					// #754: every recheck is logged, granted or shed: its outcome, the clock it saw, and the tick's error text.
					if (clock) lg({ event: 'recheck', late: !!clock.late, clockMs: clock.clockMs, ...(clock.why ? { why: clock.why } : {}), ...(clock.tick ? { tick: clock.tick } : {}), ...(clock.err ? { err: clock.err } : {}) });
					if (clock && clock.late) {
						why = 'shed';
						at = 'clock';
					}
				}
				if (why === 'shed') {
					const whyShed = disconnect ? 'disconnect' : at === 'clock' ? (clock.why || 'start-by') : shedWhy; // #752: tick-failed, disconnect
					lg({ event: 'shed', at, waitMs, depth: waiting + running, headMs: headMs(), ...(whyShed ? { why: whyShed } : {}), ...(at === 'clock' ? { clockMs: clock.clockMs } : {}) });
					blocking--;
					if (headState === state) headState = null;
					if (blocking === 0) headSince = null;
					pump();
					return PHP_SHED;
				}
				if (why === 'stale') {
					lg({ event: 'stale', waitMs, depth: waiting + running, headMs: headMs() });
					onStale();
					// The stuck run no longer owns the queue. Its end must not decrement again.
					if (prevHead && !prevHead.superseded) {
						prevHead.superseded = true;
						blocking = Math.max(0, blocking - 1);
					}
				} else if (waitMs >= GRANT_LOG_MS) {
					lg({ event: 'granted', waitMs, depth: waiting + running });
				}
				running++;
				headSince = now();
				lastProgress = headSince;
				const ranFrom = headSince;
				let outcome = 'threw';
				try {
					const out = await fn();
					outcome = 'ok';
					return out;
				} finally {
					// #1101: every contended (or long) run logs its end, so each queued or granted line has a matching released.
					const ranMs = now() - ranFrom;
					if (contended || ranMs >= GRANT_LOG_MS) lg({ event: 'released', ranMs, outcome, depth: waiting + running - 1 });
					running--;
					if (!state.superseded) blocking--;
					if (headState === state) headState = null;
					if (blocking === 0) headSince = null;
					pump();
				}
			})();
		},
	};
}

// The shed bound of a path. PHP_QUEUE_SHED_MS: an integer from 1000 to 120000 (ms), or "off" (never).
// Unset, empty or a bad value: never, on every path. Measured (#296 run 2, 2026-11-15, approach A, VPS
// checkout ladder): a 45 s default lowered completion at 250 concurrent (159 of 215, against 207 of 241
// with no shed), because a shed cart step aborts the purchase and some shed waits would have finished.
// The stale rule alone removed the memory cascade (0 stale events). The shed stays for operators who
// prefer a fast 503 to a long wait. The path argument stays so a path default can return if measured.
// eslint-disable-next-line no-unused-vars
export function shedMsFor(env, _inObject) {
	const def = 0;
	const raw = env ? env.PHP_QUEUE_SHED_MS : undefined;
	if (raw === undefined || raw === null || String(raw).trim() === '') return { ms: def, source: 'default' };
	const s = String(raw).trim();
	if (s === 'off') return { ms: 0, source: 'PHP_QUEUE_SHED_MS' };
	const n = /^[0-9]+$/.test(s) ? Number(s) : NaN;
	if (n >= 1000 && n <= 120000) return { ms: n, source: 'PHP_QUEUE_SHED_MS' };
	return { ms: def, source: 'default', refused: 'PHP_QUEUE_SHED_MS must be an integer from 1000 to 120000, or off, not ' + JSON.stringify(s) };
}
