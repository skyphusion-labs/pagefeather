// #699 part B: the rules of pf-purge-budget, the ONE purge budget of an account (the lead's ruling, 2026-11-16).
// Pure functions over the budget's stored state; worker.mjs keeps the state in its Durable Object.
// Tested in tests/budget-state.test.mjs.
//
// Workers Cache purges have Free limits per ACCOUNT: 5 a minute, a bucket of 25; past it Cloudflare refuses (code 1134).
// A Worker purges only its own cache, so the budget cannot merge purges: it SCHEDULES each site's own call. A site asks
// for a token before it sends. The budget refills below the account's limit, so the account stays under it, with room
// left for other users of the account.
//
// State: { tokens, at, queue: [{ site, since, seen }] }.
export const RATE_PER_MIN = 4; // one token per 15 s
export const BURST = 20; // the account's bucket is 25
// After a refusal the budget is empty, so the next grant is at least one of OUR intervals (15 s) away: longer than one
// refill of the account bucket (12 s at 5 a minute). One mechanism, no separate pause.
export const ACCOUNT_REFILL_MS = 12000;
export const STALE_MS = 60000; // a queued site that has not asked for this long has gone away
const INTERVAL_MS = 60000 / RATE_PER_MIN;

function fresh(now) {
	return { tokens: BURST, at: now, queue: [] };
}

function refill(s, now) {
	if (now > s.at) {
		s.tokens = Math.min(BURST, s.tokens + (now - s.at) / INTERVAL_MS);
		s.at = now;
	}
}

// acquire(st, site, now): { st, grant, retryAt }. First in, first out, with one place per site. A site is granted as
// soon as there are tokens for every site ahead of it AND for it, so a token never sits idle while the head sleeps.
export function acquire(st, site, now) {
	const s = st && st.queue ? { ...st, queue: st.queue.map((q) => ({ ...q })) } : fresh(now);
	refill(s, now);
	s.queue = s.queue.filter((q) => q.site === site || now - q.seen <= STALE_MS);
	let i = s.queue.findIndex((q) => q.site === site);
	if (i < 0) {
		s.queue.push({ site, since: now, seen: now });
		i = s.queue.length - 1;
	} else {
		s.queue[i].seen = now;
	}
	if (s.tokens >= i + 1) {
		s.tokens -= 1;
		s.queue.splice(i, 1);
		return { st: s, grant: true, retryAt: null };
	}
	// Wait until there is a token for every site ahead of it and for it.
	const need = i + 1 - s.tokens;
	return { st: s, grant: false, retryAt: now + Math.max(1000, Math.ceil(need * INTERVAL_MS)) };
}

// refused(st, site, now): a site was refused (1134) although it held a token. Another user of the account spent the
// bucket, so it is empty. The budget empties too: no site is granted until one of its own intervals has passed.
export function refused(st, site, now) {
	const s = st && st.queue ? { ...st, queue: st.queue.map((q) => ({ ...q })) } : fresh(now);
	refill(s, now);
	s.tokens = 0;
	return { st: s };
}
