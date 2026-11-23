// #1277 (the main measurement, the lead's ruling): one m: php-run line per PHP run, so a tagged guest request (probe-trace
// iso and at) can be tested against the PHP runs of its isolate. php-lock's "released" line logs only contended or long
// runs, which leaves the interval set incomplete. ON only with the site var PF_TRACE_PHP_RUNS=1, which nothing in deploy/
// renders: an operator sets it with --var on a THROWAWAY. Unset: no line, and no work past reading the flag.
// Set it with `deploy/wr deploy --config <site config> --var PF_TRACE_PHP_RUNS:1`: a deploy resets the log redaction, and
// deploy/wr re-applies it and reads it back (#1410). A deploy outside deploy/wr leaves query strings in the logs.
export function phpRunTraceOn(env) {
	return !!env && env.PF_TRACE_PHP_RUNS === '1';
}
/** The line: the isolate, the run's start (inside the granted run) and end, its length, and its call id when tagged. */
export function phpRunLine(iso, start, end, tag) {
	return { m: 'php-run', iso, start, end, ms: end - start, call: (tag && tag.call) || null };
}
