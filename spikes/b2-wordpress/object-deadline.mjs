// The front Worker's deadline on a call to the PHP Durable Object (#605).
//
// stub.fetch resolves when the object starts answering (the response headers).
// The #605 admin requests hung 62.9 s, 121.3 s and 155.4 s with no status and
// no handler log: the call never entered PHP. This bounds that wait. A call
// that has not started answering is aborted, then answered. A call that has
// started answering is returned as the object sent it.
//
// Default 90 s. The longest recorded successful object request is /_install
// at 56.7 s wall (docs/approach-b.md); Paid install is 32 s (docs/results.md).
// Admin screens are shorter (post-new page p95 14.24 s,
// docs/admin-memory-matrix.md). A 45 s queue shed cut checkouts that would
// have finished (php-lock.mjs, #296). 90 s sits above those. It cuts the
// 121.3 s and 155.4 s hangs. The 62.9 s hang is shorter than 90 s: a bound
// that kills a legitimate long request is worse than that hang.
//
// Install, import, sqlimport and cron are exempt (OBJECT_CALL_EXEMPT_PATHS):
// the caller passes deadlineMs 0 and this module does not abort them.
import { mayHaveWritten } from './object-error.mjs';
import { writeLossResponse } from './write-loss.mjs';

export const DEFAULT_OBJECT_CALL_DEADLINE_S = 90;
export const OBJECT_DEADLINE_HEADER = 'x-object-deadline';
export const OBJECT_DEADLINE_VALUE = 'no-answer';
export const DEADLINE_RETRY_AFTER_S = '5';

// One request on these paths is allowed to run past the default.
//   /_install, /_activate   WordPress install and the deploy-time plugin
//                           activation that follows it (index.js isSpikeLongOp).
//   /_sqlimport             a mysqldump loaded in the object
//   /_dbimport              a SQLite dump loaded in parts
//   /_runcron, /wp-cron.php cron over HTTP. The alarm runs inside the object
//                           and does not use this call.
export const OBJECT_CALL_EXEMPT_PATHS = Object.freeze([
	'/_install',
	'/_activate',
	'/_sqlimport',
	'/_dbimport',
	'/_runcron',
	'/wp-cron.php',
]);

const EXEMPT = new Set(OBJECT_CALL_EXEMPT_PATHS);

export function objectCallExempt(pathname) {
	return EXEMPT.has(pathname);
}

// Milliseconds, or 0 when OBJECT_CALL_DEADLINE_S=off (no deadline).
// Unset or a value that is not a number from 0.01 to 600: the default.
export function objectCallDeadlineMs(env) {
	const raw = env && env.OBJECT_CALL_DEADLINE_S;
	if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_OBJECT_CALL_DEADLINE_S * 1000;
	const s = String(raw).trim();
	if (s === 'off') return 0;
	if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return DEFAULT_OBJECT_CALL_DEADLINE_S * 1000;
	const n = Number(s);
	if (!(n >= 0.01) || n > 600) return DEFAULT_OBJECT_CALL_DEADLINE_S * 1000;
	return Math.round(n * 1000);
}

export class ObjectCallDeadlineError extends Error {
	constructor(deadlineMs) {
		super('PHP object did not start answering within ' + deadlineMs + ' ms');
		this.name = 'ObjectCallDeadlineError';
		this.deadline = true;
		this.deadlineMs = deadlineMs;
	}
}

// True only once the client response is attached. A bare timeout is not yet
// an answer, and a platform reset (no deadline flag) is not this error.
export function isObjectCallDeadline(e) {
	return !!(e && e.deadline === true && e.response);
}

// The client answer. A method that may have written (object-error.mjs
// mayHaveWritten: anything but GET, HEAD or OPTIONS) gets the write-loss
// 500: the call was dispatched and aborted before any response headers, so
// the handler may already have written. No frame is probed here, so this
// never says nothing was saved and never sets x-isolate-reset. A safe
// method gets 503, Retry-After and x-object-deadline, the same shape as an
// isolate reset the client can retry.
export function objectDeadlineAnswer({ method, objectName, json }) {
	if (mayHaveWritten(method)) {
		const wl = writeLossResponse('unknown', !!json);
		const headers = { ...wl.headers, [OBJECT_DEADLINE_HEADER]: OBJECT_DEADLINE_VALUE };
		if (objectName) headers['x-php-object'] = objectName;
		delete headers['x-isolate-reset'];
		return { status: wl.status, headers, body: wl.body };
	}
	const headers = {
		'content-type': 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		'retry-after': DEADLINE_RETRY_AFTER_S,
		[OBJECT_DEADLINE_HEADER]: OBJECT_DEADLINE_VALUE,
	};
	if (objectName) headers['x-php-object'] = objectName;
	return {
		status: 503,
		headers,
		body: 'The site did not answer. Please try again in a few seconds.\n',
	};
}

// stub.fetch, or an ObjectCallDeadlineError whose .response is the client
// answer. deadlineMs 0 disables the bound (exempt paths). controller, when
// passed, must already be request.signal: index.js builds that request.
// A platform error from the stub is rethrown unchanged so the reset and
// overload paths still classify it.
export async function callPhpObject(stub, request, opts = {}) {
	const deadlineMs = Number(opts.deadlineMs) > 0 ? Number(opts.deadlineMs) : 0;
	if (!(deadlineMs > 0)) return stub.fetch(request);
	const ac = opts.controller instanceof AbortController ? opts.controller : new AbortController();
	const sent = request.signal === ac.signal ? request : new Request(request, { signal: ac.signal });
	try {
		return await raceFetch(stub, sent, deadlineMs, ac);
	} catch (e) {
		if (!(e && e.deadline === true)) throw e;
		const ans = objectDeadlineAnswer({
			method: opts.method || request.method,
			objectName: opts.objectName || '',
			json: !!opts.json,
		});
		if (opts.pfReq) ans.headers['x-pf-req'] = opts.pfReq;
		e.response = new Response(ans.body, { status: ans.status, headers: ans.headers });
		throw e;
	}
}

async function raceFetch(stub, request, deadlineMs, ac) {
	let timer;
	const pending = Promise.resolve()
		.then(() => stub.fetch(request))
		.then(
			(r) => ({ r }),
			(error) => ({ error }),
		);
	try {
		const winner = await Promise.race([
			pending,
			new Promise((resolve) => { timer = setTimeout(() => resolve({ deadline: true }), deadlineMs); }),
		]);
		if (winner.deadline) {
			ac.abort();
			throw new ObjectCallDeadlineError(deadlineMs);
		}
		if (winner.error) throw winner.error;
		return winner.r;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
