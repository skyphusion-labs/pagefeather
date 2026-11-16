// #699, step 1 (red first): TODAY's purge rules of the PHP object, moved out of index.js unchanged so a test can
// read them. A refused purge is retried ONCE, one gap later; refused again, it is dropped. There is no expiry.
export const PURGE_GAP_MS = 15000;
export const RETRY_MS = [PURGE_GAP_MS];

export function purgeWindowMs(env) {
	return Infinity;
}

export function onAsk(st, now) {
	const s = { ...(st || {}) };
	const coalesced = !!s.pending;
	s.lastAsked = now;
	s.pending = true;
	if (!coalesced) s.firstAsked = now;
	const alarmAt = coalesced ? null : Math.max(now, (s.lastSent || 0) + PURGE_GAP_MS);
	return { st: s, alarmAt, coalesced };
}

export function onDue(st, now) {
	const s = { ...(st || {}) };
	if (!s.pending) return { st: s, action: 'none', covered: null };
	const covered = { firstAsked: s.firstAsked };
	s.pending = false;
	s.lastSent = now;
	return { st: s, action: 'send', covered };
}

export function onResult(st, now, r, covered) {
	const s = { ...(st || {}) };
	const ok = !!(r && r.ok);
	if (ok) return { st: s, alarmAt: null, outcome: 'ok' };
	if (r && r.error) return { st: s, alarmAt: null, outcome: 'unavailable' };
	if (!s.retried) {
		s.retried = true;
		s.pending = true;
		return { st: s, alarmAt: now + PURGE_GAP_MS, outcome: 'refused' };
	}
	s.retried = false;
	return { st: s, alarmAt: null, outcome: 'refused' };
}
