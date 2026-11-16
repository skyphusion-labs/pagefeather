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
		return { refuseNow: false, shedMs: baseShedMs, byStartBy: false, startBy: 0 };
	}
	// startBy: the parsed bound, so the caller never parses the header again (#715 review3 7).
	const left = startBy - now;
	if (left <= 0) return { refuseNow: true, shedMs: 0, byStartBy: true, startBy };
	if (baseShedMs > 0 && baseShedMs < left) return { refuseNow: false, shedMs: baseShedMs, byStartBy: false, startBy };
	return { refuseNow: false, shedMs: left, byStartBy: true, startBy };
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
// #715 review3 4: the tick costs a timer turn with the lock held, so it runs only when the start-by is nearer than the
// lag one run ahead can cause (CLOCK_LAG_MAX_MS, the per-request CPU limit). Several CPU-bound runs in a row can lag
// more; the arrival refusal and the lock's own timer still bound those, and clockMs on a shed line measures the lag.
export const CLOCK_LAG_MAX_MS = 30000;
export async function recheckStartBy(startByAt, { now = Date.now, tick = () => new Promise((r) => setTimeout(r, 0)), lagMs = CLOCK_LAG_MAX_MS, signal = null } = {}) {
	const stale = now();
	if (startByAt - stale >= lagMs) return { late: false, clockMs: 0, ticked: false };
	// #754 (the lead's rule, from the live proof): the tick exists to MOVE the clock, and a FAILED subrequest moves it too
	// (measured: clockMs 12.5 to 20.8 s on refused self-fetches). So after the tick SETTLES, ok or error, re-read the clock
	// and decide by the start-by. Only a clock that did NOT advance across the tick is unknown: then shed, why tick-failed.
	let tickOutcome = 'ok', err;
	try {
		await tick();
	} catch (e) {
		tickOutcome = 'error';
		err = String((e && e.message) || e).slice(0, 160);
	}
	const fresh = now();
	const seen = { clockMs: fresh - stale, tick: tickOutcome, ...(err ? { err } : {}) };
	// #752, #721: a caller that disconnected while this waited: its abort is only seen after the real I/O.
	if (signal && signal.aborted) return { late: true, why: 'disconnect', ...seen };
	if (fresh === stale) return { late: true, why: 'tick-failed', ...seen };
	const late = fresh >= startByAt;
	return { late, ...(late ? { why: 'start-by' } : {}), ...seen };
}

// #752: the tick is a REAL subrequest. Measured on the edge (#752, 2026-11-16): only a fetch moved Date.now() in a Durable
// Object (5 of 5 rechecks saw the true clock); a setTimeout(0) turn, a storage read and the assets binding did not. The
// endpoint is the site's own front Worker, which answers TICK_PATH before any object call: it never reaches the PHP
// object (busy holding the head), and it needs no outside service. One subrequest per CONTENDED grant within
// CLOCK_LAG_MAX_MS of a start-by, inside the waiter's own invocation (Workers Free: 50 subrequests per invocation).
export const TICK_PATH = '/_tick';
export const TICK_TIMEOUT_MS = 2000;
// #754: the tick's target. START_BY_TICK_URL (an https URL: a tiny dedicated Worker, outside the site's hostname, since
// the live proof showed the object's fetch to its OWN hostname is refused), else the site origin + TICK_PATH.
export function tickUrl(env, origin) {
	const u = env && env.START_BY_TICK_URL ? String(env.START_BY_TICK_URL).trim() : '';
	return /^https:\/\/[A-Za-z0-9.-]+(\/[^\s]*)?$/.test(u) ? u : origin + TICK_PATH;
}
export async function tickFetch(target, { fetchImpl = fetch, timeoutMs = TICK_TIMEOUT_MS, full = false } = {}) {
	const r = await fetchImpl(full ? target : target + TICK_PATH, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
	try { if (r.body) await r.body.cancel(); } catch {}
	if (r.status !== 204) throw new Error('tick answered ' + r.status);
}
// The front Worker's answer to TICK_PATH: an empty 204 that no cache keeps.
export function tickResponse() {
	const headers = new Headers();
	noStoreAnywhere(headers);
	return new Response(null, { status: 204, headers });
}

// #721 escape hatch: OBJECT_DISCONNECT_SHED=off hands the PHP lock no signal, so a queued waiter ignores its caller's
// disconnect and only the start-by applies. Unset, on or a bad value: the signal (the render refuses a bad value).
export function disconnectSignal(env, signal) {
	return env && env.OBJECT_DISCONNECT_SHED === 'off' ? null : signal || null;
}

// #721: the caller disconnected while its call was in flight (request.signal, with enable_request_signal). No client
// reads this; it exists so the Worker answers instead of throwing an AbortError (an exception outcome, which doctor
// counts as a failure). An object run that started is never cancelled (measured on the edge, #721), so a method that
// may write says unknown.
export function disconnectAnswer(method) {
	const safe = ['GET', 'HEAD', 'OPTIONS'].includes(String(method || '').toUpperCase());
	const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'x-write-loss': safe ? 'none' : 'unknown' });
	noStoreAnywhere(headers);
	return new Response('The connection closed before the answer.\n', { status: 499, headers });
}

// A request the object never ran because it was not granted by its start-by.
export function startByResponse() {
	return shedAnswer('The site is busy and did not start your request. Please try again in a few seconds.\n', { 'x-object-deadline': 'queued', 'x-write-loss': 'none' });
}

// #715 review2 1, review3 3: the call id rides only on an answer the edge never keeps. A cacheable page would carry one
// request's id to every later hit, so a client-seen id would no longer name its request. The edge obeys the Worker's
// own directive, cloudflare-cdn-cache-control (handle's pageCacheHeaders sets it on every page: an edge TTL or
// no-store), so that decides, never WordPress's cache-control. A Worker failure answer (deadline, write-loss, error,
// shed) has no edge directive and its own cache-control: no-store. Directives are compared whole, by name, so a field
// form such as private="set-cookie" is never read as no-store. An immutable answer is copied once.
function hasNoStore(v) {
	return String(v || '').toLowerCase().split(',').some((d) => d.split('=')[0].trim() === 'no-store');
}
export function tagCallId(r, callId) {
	const edge = r.headers.get('cloudflare-cdn-cache-control');
	if (!hasNoStore(edge === null ? r.headers.get('cache-control') : edge)) return r;
	try {
		r.headers.set(CALL_HEADER, callId);
		return r;
	} catch {
		const out = new Response(r.body, r);
		out.headers.set(CALL_HEADER, callId);
		return out;
	}
}
