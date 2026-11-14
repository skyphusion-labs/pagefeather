// The move freeze's cron half (#479): while a store is being copied, the object's alarm must not
// run the WordPress cron leg. In #479 M2 an idle, unfrozen store's Action Scheduler wrote
// wp_actionscheduler_logs during an export, so the copy could not be proved complete; in M3,
// with the cron leg held, 0 of 61 tables changed in 5 minutes.
//
// POST /_hold?ms=<n> holds the cron for n ms from now (60000 to 7200000); POST /_hold?off=1
// ends it; GET /_hold reads it. The hold ends by itself at its time, so a move that dies leaves
// the store's cron held for at most 2 hours. Operator-only: index.js answers every /_ path with
// 403 unless the spike token is valid. The front-door half is deploy/wfp/dispatcher/worker.js.

export const MOVE_HOLD_KEY = 'move-hold-until';
export const MOVE_HOLD_MIN_MS = 60 * 1000;
export const MOVE_HOLD_MAX_MS = 2 * 60 * 60 * 1000;

// What a /_hold request asks for: {read: true}, {until: ms}, {clear: true}, or {error}.
export function moveHoldAsk(method, url, now) {
	if (method === 'GET') return { read: true };
	if (method !== 'POST') return { error: 'GET or POST only', status: 405 };
	if (url.searchParams.get('off') === '1') return { clear: true };
	const ms = url.searchParams.get('ms');
	if (!/^\d{1,8}$/.test(ms || '')) return { error: 'ms must be a whole number of milliseconds', status: 400 };
	const n = Number(ms);
	if (n < MOVE_HOLD_MIN_MS || n > MOVE_HOLD_MAX_MS) return { error: `ms must be from ${MOVE_HOLD_MIN_MS} to ${MOVE_HOLD_MAX_MS}`, status: 400 };
	return { until: now + n };
}

// Run a /_hold request against the object's storage (get/put/delete).
export async function moveHoldRequest(storage, method, url, now = Date.now()) {
	const ask = moveHoldAsk(method, url, now);
	const json = (o, status = 200) => Response.json(o, { status, headers: { 'cache-control': 'private, no-store' } });
	if (ask.error) return json({ ok: false, error: ask.error }, ask.status);
	if (ask.clear) await storage.delete(MOVE_HOLD_KEY);
	if (ask.until) await storage.put(MOVE_HOLD_KEY, ask.until);
	const until = Number((await storage.get(MOVE_HOLD_KEY)) || 0);
	return json({ ok: true, held: until > now, until: until > now ? until : null });
}
