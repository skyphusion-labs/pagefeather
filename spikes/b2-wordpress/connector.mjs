// One database connection at a time, opened on first use (#1101).
// mysql-bridge.js used to cache the connect promise and never clear it on a REJECTION. One transient Hyperdrive connect
// failure ("Network connection lost.", measured on cf759hx under checkout load) then failed every later statement of the
// run, 17 of 17, though none had run. Here a rejected connect is retried once at once (attempts, default 2). If that
// fails too, the error stands, so the run answers the named retryable 503 as before, and the next statement tries again
// (never poisoned). A connect failure means no statement ran, so nothing was written: the retry is safe.
// BOUNDED (the lead's review of #1102): withDbRun (#1088) awaits end() INSIDE the PHP lock, so an await that never settles
// would hold the lock and hang every request queued behind it. Each connect attempt is bounded by connectMs (3 s; a
// Hyperdrive connect measures tens of ms), and end() by endMs (2 s; a COM_QUIT and a socket close). On expiry a named
// '@event' is logged (connect-timeout, db-end-timeout) and the reference is dropped, so the lock always releases; a
// connection whose end() timed out is destroyed. Measured on cf759hx (#1101): both hung add-to-carts were this, a
// ctx.waitUntil(end()) on a dead socket after the response, with nothing pending.
// reset() forgets the connection without touching it (it may belong to another I/O context); end() clears the references
// FIRST, then closes. A connect still in flight is closed once it lands, and never becomes the cached connection after a
// reset or an end.
export const CONNECT_MS = 3000;
export const END_MS = 2000;
const TIMED_OUT = Symbol('timed out');

/** p, or TIMED_OUT after ms (the timer is cleared either way). */
function within(p, ms) {
	let t;
	const timer = new Promise((ok) => {
		t = setTimeout(() => ok(TIMED_OUT), ms);
	});
	return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

// #1169: onOpen(ms, attempts) after each successful open (ms from the first attempt's start), for the perf line.
export function createConnector(factory, { attempts = 2, connectMs = CONNECT_MS, endMs = END_MS, log = () => {}, onOpen = null } = {}) {
	let conn = null;
	let connecting = null;
	async function open() {
		let last;
		const t0 = Date.now();
		for (let i = 0; i < attempts; i++) {
			try {
				const attempt = Promise.resolve().then(factory);
				const c = await within(attempt, connectMs);
				if (c === TIMED_OUT) {
					log({ '@event': 'connect-timeout', m: 'connect-timeout', attempt: i + 1, ms: connectMs });
					// A late connect is closed when it lands; it never becomes this run's connection.
					attempt.then((late) => late && late.end && late.end().catch(() => {}), () => {});
					throw new Error('connect timed out after ' + connectMs + ' ms');
				}
				if (onOpen) {
					try { onOpen(Date.now() - t0, i + 1); } catch { /* a counter never fails the connect */ }
				}
				return c;
			} catch (e) {
				last = e;
			}
		}
		throw last;
	}
	return {
		get() {
			if (conn) return Promise.resolve(conn);
			if (!connecting) {
				const p = open().then(
					(c) => {
						if (connecting === p) {
							conn = c;
							connecting = null;
						}
						return c;
					},
					(e) => {
						if (connecting === p) connecting = null;
						throw e;
					},
				);
				connecting = p;
			}
			return connecting;
		},
		reset() {
			conn = null;
			connecting = null;
		},
		async end() {
			const c = conn;
			const pending = connecting;
			conn = null;
			connecting = null;
			let done = c;
			if (!done && pending) {
				const r = await within(pending.catch(() => null), endMs);
				if (r === TIMED_OUT) {
					log({ '@event': 'db-end-timeout', m: 'db-end-timeout', after: 'pending-connect', ms: endMs });
					pending.then((late) => late && late.end && late.end().catch(() => {}), () => {});
					return;
				}
				done = r;
			}
			if (!done) return;
			const r = await within(Promise.resolve().then(() => done.end()).catch(() => {}), endMs);
			if (r === TIMED_OUT) {
				log({ '@event': 'db-end-timeout', m: 'db-end-timeout', after: 'end', ms: endMs });
				// #1101: the socket is dead (a QUIT reply never came). destroy() closes it with no reply needed, so it is torn
				// down, not left pending.
				try {
					if (typeof done.destroy === 'function') done.destroy();
				} catch {
					// nothing more to release
				}
			}
		},
	};
}

// #1359 (a): each QUERY is bounded too. A query that never settles held its PHP run, and with it the isolate's lock: every
// later request on that isolate was shed for as long as the isolate lived (cf759hl, #1277 arm (b): one for 56 minutes).
// DB_QUERY_TIMEOUT_MS (1 ms to 10 minutes; 30 s by default): no measured path runs one query near 30 s (the highest
// per-query average in any request was 214 ms, and the longest requests are thousands of ~14 ms queries, #1359).
// On the bound the caller gets a QueryTimeout (errno 2013, "Lost connection to MySQL server during query"): it destroys
// the connection, never reuses it, and never retries the statement (a retry could wait the bound again).
export const QUERY_MS = 30000;
const QUERY_MAX_MS = 600000;
export function queryTimeoutMs(env) {
	const raw = env && env.DB_QUERY_TIMEOUT_MS;
	if (raw === undefined || raw === null || !/^[0-9]+$/.test(String(raw).trim())) return QUERY_MS;
	const n = Number(raw);
	if (n <= 0) return QUERY_MS;
	return Math.min(QUERY_MAX_MS, n);
}
export class QueryTimeout extends Error {
	constructor(ms) {
		super('mysql: query timed out after ' + ms + ' ms (DB_QUERY_TIMEOUT_MS): connection dropped');
		this.errno = 2013;
		this.timedOut = true;
		this.ms = ms;
	}
}
/** The query's result, or a QueryTimeout after ms. */
export async function boundedQuery(p, ms) {
	const r = await within(Promise.resolve(p), ms);
	if (r === TIMED_OUT) throw new QueryTimeout(ms);
	return r;
}
