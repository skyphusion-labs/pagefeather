// The one-at-a-time PHP lock of an isolate (#296 step 1.1). index.js withPhp runs every PHP run through it.
//
// One PHP runtime per isolate, and PHP is not re-entrant, so runs go one at a time in arrival order.
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
//   log    { event: queued | granted | shed | stale, depth, waitMs, headMs }: queued when a run arrives
//          behind another, granted when it waited 1 s or more, and every shed and stale. An
//          uncontended run logs nothing.
// Pure and clock-injected, so tests/php-lock.test.mjs drives it on a fake clock.

export const PHP_SHED = Symbol('php-shed');
const TICK_MS = 1000;
const GRANT_LOG_MS = 1000;

// yieldTurn (#755): one macrotask, so an event already queued (a caller's abort) runs before the grant decides. Injected
// for tests; the default is a real setTimeout(0), never the injected setTimer (fake clocks there may never fire).
export function createPhpLock({ staleMs = 60000, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {}, yieldTurn = () => new Promise((r) => setTimeout(r, 0)) } = {}) {
	let tail = Promise.resolve();
	let waiting = 0;
	let running = 0;
	let headSince = null; // when the newest executing run started; null when none executes
	const headMs = () => (headSince === null ? 0 : now() - headSince);

	// Resolves 'turn' when prev settles, 'stale' when the run ahead has executed staleMs, 'shed' at shedMs, and 'gone'
	// when signal aborts (#721: the caller disconnected; it needs enable_request_signal).
	function waitTurn(prev, t0, shedMs, signal) {
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
				if (headSince !== null && headMs() >= staleMs) return finish('stale');
				let next = TICK_MS;
				if (shedMs > 0) next = Math.min(next, Math.max(1, t0 + shedMs - now()));
				if (headSince !== null) next = Math.min(next, Math.max(1, headSince + staleMs - now()));
				timer = setTimer(check, next);
			};
			// The first check after the promise settles in the same tick would be wasted: wait one tick.
			timer = setTimer(check, Math.min(TICK_MS, shedMs > 0 ? shedMs : TICK_MS));
		});
	}

	return {
		get waiting() { return waiting; },
		get running() { return running; },
		// run(fn, { shedMs, onStale, tag }): fn's result, or PHP_SHED. onStale runs before fn when the lock was
		// taken as stale (index.js drops the runtime there). tag (#708) is added to this run's log lines (the
		// correlation id of the forwarded request), so a queued, granted or shed line names its request.
		// shedWhy (#715 review2 8) names the bound on a shed line: start-by, or the operator's queue-shed.
		// recheck (#715 review3 5): an async start-by check at a contended grant (the clock may be stale there,
		// start-by.mjs recheckStartBy). { late: true } sheds before any grant line: at: clock, why: start-by.
		// signal (#721): the caller's request.signal. A waiter whose caller disconnected sheds (why: disconnect) and never
		// runs: on arrival, while it waits, or at its grant. A run that has started is never stopped by it.
		run(fn, { shedMs = 0, onStale = () => {}, tag = null, shedWhy = null, recheck = null, signal = null } = {}) {
			const lg = tag ? (e) => log({ ...e, ...tag }) : log;
			if (signal && signal.aborted) {
				// Gone before it queued: it takes no place in the order.
				lg({ event: 'shed', at: 'arrive', waitMs: 0, depth: waiting + running, headMs: headMs(), why: 'disconnect' });
				return Promise.resolve(PHP_SHED);
			}
			const prev = tail;
			let release;
			const mine = new Promise((r) => (release = r));
			tail = mine;
			const t0 = now();
			const contended = waiting + running > 0;
			if (contended) lg({ event: 'queued', depth: waiting + running, headMs: headMs() });
			waiting++;
			return (async () => {
				let why = contended ? await waitTurn(prev, t0, shedMs, signal) : 'turn';
				waiting--;
				const waitMs = now() - t0;
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
				// #755: a caller that hung up while a CPU-bound run kept the isolate busy has its abort event delivered only when
				// that run ends, queued as a task BEHIND this grant (measured on pf755i: the grant read aborted=false at
				// 13311 ms, the abort ran at 13318 ms, and the abandoned request ran). Yield one macrotask, then read again.
				// Only a contended grant with a caller signal pays it; cron, imports and an idle object never yield.
				if (why !== 'shed' && contended && signal) {
					await yieldTurn();
					if (signal.aborted) {
						at = 'grant';
						why = 'shed';
						disconnect = true;
					}
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
					// #755: the recheck's tick is real I/O; a caller that hung up during it is gone too.
					if (why !== 'shed' && signal && signal.aborted) {
						at = 'grant';
						why = 'shed';
						disconnect = true;
					}
				}
				if (why === 'shed') {
					const whyShed = disconnect ? 'disconnect' : at === 'clock' ? (clock.why || 'start-by') : shedWhy; // #752: tick-failed, disconnect
					lg({ event: 'shed', at, waitMs, depth: waiting + running, headMs: headMs(), ...(whyShed ? { why: whyShed } : {}), ...(at === 'clock' ? { clockMs: clock.clockMs } : {}) });
					// This waiter never runs: the one behind it waits for the run ahead instead.
					prev.then(release, release);
					return PHP_SHED;
				}
				if (why === 'stale') {
					lg({ event: 'stale', waitMs, depth: waiting + running, headMs: headMs() });
					onStale();
				} else if (waitMs >= GRANT_LOG_MS) {
					lg({ event: 'granted', waitMs, depth: waiting + running });
				}
				running++;
				headSince = now();
				try {
					return await fn();
				} finally {
					running--;
					if (running === 0) headSince = null;
					release();
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
