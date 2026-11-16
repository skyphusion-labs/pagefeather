// #744: the database failures of one /_activate run, for its answer. Before, /_activate returned the first 2,000
// characters of PHP's error output, which cut WordPress's database error mid-query, so a failing statement during a
// plugin's activation was not named (WooCommerce's cart-page probe: "LIKE or GLOB pattern too complex"). Every failed
// statement goes through index.js noteFailure with its SQL and error and a sequence number; failuresSince returns the
// ones after the run's start, bounded: the total count, at most MAX_FAILURES entries, each error and SQL cut to a
// length that keeps the message itself.
export const MAX_FAILURES = 20;
export const ERROR_CHARS = 400;
export const SQL_CHARS = 240;

export function failuresSince(failures, seq0) {
	const since = (failures || []).filter((f) => f && typeof f.seq === 'number' && f.seq > seq0);
	return {
		count: since.length,
		failures: since.slice(0, MAX_FAILURES).map((f) => ({ error: String(f.error || '').slice(0, ERROR_CHARS), sql: String(f.sql || '').slice(0, SQL_CHARS) })),
	};
}
