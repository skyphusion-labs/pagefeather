// #1215: a non-blocking wp_remote_*() (blocking => false) is fire-and-forget, as in core. WP_Http::request() sends it
// and returns an empty response at once; the far end runs to completion. Action Scheduler's async queue runner is one:
// at the shutdown of an admin request it POSTs admin-ajax.php with blocking false and timeout 0.01, and that run is
// how a due action (a deferred order email) runs within a second. The bridge ignored 'blocking' and awaited the answer
// under its 1 s floor, so on approach A the loopback to the ovf-self object was cut off at 1 s and the email waited for
// the cron alarm (12 to 122 s on cf759hl).
//
// So: blocking false (the boolean php/http-bridge.php sends) is answered at once, and the request runs in the
// request's waitUntil under NONBLOCKING_CAP_MS, never the caller's timeout, which exists only to not wait.

// A Worker keeps waitUntil work for about 30 s after its response.
export const NONBLOCKING_CAP_MS = 30000;

export function httpBlocking(op) {
	return !(op && op.blocking === false);
}

export function httpTimeoutMs(op) {
	if (!httpBlocking(op)) return NONBLOCKING_CAP_MS;
	return Math.max(1, Number(op && op.timeout) || 5) * 1000;
}
