import { noStoreAnywhere } from './perf-headers.mjs';
import { secondsMs, objectCallExempt } from './object-deadline.mjs';
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
// OBJECT_START_BY_S sets it in seconds, 1 to 600 (clamped below the deadline, so the deadline can never catch a
// request that did not start), and "off" turns it off. An explicit value also stands on its own when #703's
// deadline is off (#708 review 6). An exempt path (install, import, cron) never gets one. Clock skew between the
// Worker and object isolates moves the bound by the skew.

export const START_BY_HEADER = 'x-pf-start-by'; // absolute epoch ms; only the Worker sets it
export const CALL_HEADER = 'x-pf-call'; // the correlation id of one forwarded request (no request data)
export const START_BY_RETRY_AFTER_S = '5';

const RUN_ALLOWANCE_MS = 30000;

export function startByMs(env, deadlineMs, { exempt = false } = {}) {
	if (exempt) return 0;
	const ceiling = deadlineMs > 0 ? deadlineMs - Math.min(RUN_ALLOWANCE_MS, Math.floor(deadlineMs / 3)) : 0;
	const ms = secondsMs(env && env.OBJECT_START_BY_S, 1, 600);
	if (ms === 'off') return 0;
	if (ms === null) return ceiling; // unset or a bad value keeps the default (none, with the deadline off)
	return ceiling > 0 ? Math.min(ms, ceiling) : ms;
}

// #715 review2 6: the paths that never get a start-by. Every operator and control path (/_*: /_evict, /_hold, /_build,
// the exports, the snapshot; each needs the spike or snapshot token) and #703's exempt paths (cron over HTTP). A deploy's
// /_evict or a site move's /_hold that waited must still run: a refusal there fails the deploy step.
export function startByExempt(pathname) {
	return pathname.startsWith('/_') || objectCallExempt(pathname);
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

// #715 review2 10: the one shed answer. Both sheds (the start-by, and the operator's PHP_QUEUE_SHED_MS) are a retry-safe
// 503 that says x-overloaded (review 4), never stored, at the edge either (review 3).
export function shedAnswer(body, extra = {}) {
	const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'retry-after': START_BY_RETRY_AFTER_S, 'x-overloaded': '1', 'x-php-lock': 'shed', ...extra });
	noStoreAnywhere(headers);
	return new Response(body, { status: 503, headers });
}

// #715 review2 4: in a deployed Worker, Date.now() is "the time of the last I/O" and does not advance during code
// (developers.cloudflare.com/workers/reference/security-model). A run ahead that ends in a CPU stretch grants the next on
// a clock that lags by that stretch: up to the per-request CPU limit (30 s by default), summed over consecutive CPU-bound
// runs, so more than the 30 s run allowance. A request that queued reads the clock again after one timer turn. The docs
// do not say that a timer turn moves the clock, so clockMs is logged: 0 on a live site means the tick did not move it.
export async function recheckStartBy(startByAt, { now = Date.now, tick = () => new Promise((r) => setTimeout(r, 0)) } = {}) {
	const stale = now();
	await tick();
	const fresh = now();
	return { late: fresh >= startByAt, clockMs: fresh - stale };
}

// A request the object never ran because it was not granted by its start-by.
export function startByResponse() {
	return shedAnswer('The site is busy and did not start your request. Please try again in a few seconds.\n', { 'x-object-deadline': 'queued', 'x-write-loss': 'none' });
}

// #715 review2 1: the call id rides only on an answer no cache keeps (no-store or private). A cacheable page would carry
// one request's id to every later hit, so a client-seen id would no longer name its request. The failure answers
// (deadline, write-loss, error, shed) are all no-store. An immutable answer is copied once.
export function tagCallId(r, callId) {
	const cc = (r.headers.get('cache-control') || '').toLowerCase();
	if (!callId || !/(^|[\s,])(no-store|private)([\s,=]|$)/.test(cc)) return r;
	try {
		r.headers.set(CALL_HEADER, callId);
		return r;
	} catch {
		const out = new Response(r.body, r);
		out.headers.set(CALL_HEADER, callId);
		return out;
	}
}
