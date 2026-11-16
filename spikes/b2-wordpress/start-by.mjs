// #708: a request still QUEUED in a PHP object when its caller has given up must never run. A checkout would commit
// after the shopper saw a failure (#703's "500 unknown", or a client timeout), and a retry would buy twice.
//
// The object cannot rely on seeing the caller's abort: a fetch handler's request.signal fires on a client disconnect
// only with the compatibility flag enable_request_signal, and Cloudflare's docs do not say whether a Durable Object
// sees its CALLER's stub.fetch() abort. So the bound is a clock, not a signal. The Worker stamps each forwarded
// request with a start-by (its send time + Q). The object hands the remainder to the PHP lock as that run's shed
// bound, and a waiter shed by the lock never runs: the lock sheds before fn (php-lock.mjs). A shed answers a fast,
// retry-safe 503 that says the request was queued and never ran. #703's deadline then only ever catches a request
// that STARTED, so its "500 unknown" is honest.
//
// Q defaults to the #703 deadline minus a run allowance: 30 s, or a third of a deadline under 90 s (90 s -> 60 s).
// OBJECT_START_BY_S sets it in seconds (clamped to the default ceiling, so it can never pass the deadline's own
// start), and "off" turns it off. Clock skew between the Worker and object isolates moves the bound by the skew.

export const START_BY_HEADER = 'x-pf-start-by'; // absolute epoch ms; only the Worker sets it
export const CALL_HEADER = 'x-pf-call'; // the correlation id of one forwarded request (no request data)
export const START_BY_RETRY_AFTER_S = '5';

const RUN_ALLOWANCE_MS = 30000;

export function startByMs(env, deadlineMs) {
	if (!(deadlineMs > 0)) return 0;
	const ceiling = deadlineMs - Math.min(RUN_ALLOWANCE_MS, Math.floor(deadlineMs / 3));
	const raw = env && env.OBJECT_START_BY_S;
	if (raw === undefined || raw === null) return ceiling;
	const s = String(raw).trim();
	if (s === 'off') return 0;
	if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return ceiling;
	const ms = Math.round(Number(s) * 1000);
	if (!(ms >= 1000) || ms > 600000) return ceiling;
	return Math.min(ms, ceiling);
}

// The object's decision before it queues: refuseNow (the start-by has passed: answer without queuing), or the shed
// bound to give the lock, and whether that bound is the start-by (byStartBy) or the operator's PHP_QUEUE_SHED_MS.
export function objectShedPlan(startByHeader, now, baseShedMs) {
	const startBy = Number(startByHeader);
	if (startByHeader === null || startByHeader === undefined || startByHeader === '' || !Number.isFinite(startBy) || startBy <= 0) {
		return { refuseNow: false, shedMs: baseShedMs, byStartBy: false };
	}
	const left = startBy - now;
	if (left <= 0) return { refuseNow: true, shedMs: 0, byStartBy: true };
	if (baseShedMs > 0 && baseShedMs < left) return { refuseNow: false, shedMs: baseShedMs, byStartBy: false };
	return { refuseNow: false, shedMs: left, byStartBy: true };
}

// A request the object never ran because it was not granted by its start-by.
export function startByResponse() {
	const headers = new Headers({
		'content-type': 'text/plain; charset=utf-8',
		'retry-after': START_BY_RETRY_AFTER_S,
		'x-object-deadline': 'queued',
		'x-write-loss': 'none',
		'x-php-lock': 'shed',
		'cache-control': 'no-store, private',
	});
	return new Response('The site is busy and did not start your request. Please try again in a few seconds.\n', { status: 503, headers });
}
