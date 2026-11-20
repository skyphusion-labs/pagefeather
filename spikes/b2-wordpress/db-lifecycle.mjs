// Approach A's MySQL connection lives exactly ONE PHP run (#1087).
// mysql-bridge.js keeps one module-level connection per isolate, and a Worker socket belongs to the I/O context that
// opened it: another context (a later alarm leg, another request, another Durable Object in the same isolate) that
// touches it throws "Cannot perform I/O on behalf of a different Durable Object". Measured on cf759hx (A_CRON=1): the
// cron object's alarm path neither reset nor ended the connection, so a leg reused an earlier leg's socket. Each leg's
// open socket also kept its invocation alive about 59 s, and after an order, every leg threw 16 such errors.
// withDbRun is called inside the PHP lock (index.js withPhp): it drops any connection another context left, runs fn,
// and ends the connection (awaited) before the lock is released. PHP runs are serialized per isolate, so no two
// contexts can hold the socket at once. No database handler (b-dosql): fn runs unchanged.
export async function withDbRun(dbHandler, fn) {
	if (!dbHandler) return fn();
	dbHandler.reset();
	try {
		return await fn();
	} finally {
		try {
			await dbHandler.end();
		} catch {
			// a close that fails leaves nothing to reuse: end() cleared the references first
		}
	}
}
