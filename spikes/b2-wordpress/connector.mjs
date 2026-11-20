// One database connection at a time, opened on first use (#1101).
// mysql-bridge.js used to cache the connect promise and never clear it on a REJECTION. One transient Hyperdrive connect
// failure ("Network connection lost.", measured on cf759hx under checkout load) then failed every later statement of the
// run, 17 of 17, though none had run. Here a rejected connect is retried once at once (attempts, default 2). If that
// fails too, the error stands, so the run answers the named retryable 503 as before, and the next statement tries again
// (never poisoned). A connect failure means no statement ran, so nothing was written: the retry is safe.
// reset() forgets the connection without touching it (it may belong to another I/O context); end() clears the references
// FIRST, then closes. A connect still in flight is closed once it lands, and never becomes the cached connection after a
// reset or an end.
export function createConnector(factory, { attempts = 2 } = {}) {
	let conn = null;
	let connecting = null;
	async function open() {
		let last;
		for (let i = 0; i < attempts; i++) {
			try {
				return await factory();
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
			const done = c || (pending && (await pending.catch(() => null)));
			if (done) await done.end().catch(() => {});
		},
	};
}
