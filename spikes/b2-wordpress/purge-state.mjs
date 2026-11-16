// #699: the purge rules of a site's PHP object, as pure functions over its stored state (index.js keeps the state in
// storage under PURGE_STATE_KEY and arms the alarm these return). Tested in tests/purge-state.test.mjs.
//
// Workers Cache purges always have Free limits: 5 a minute per ACCOUNT, a bucket of 25 (#699). A refused purge
// (code 1134) used to be retried once and then dropped, so the edited page stayed old until its copy aged out. Now a
// refused purge stays pending and is retried with a back-off, never dropped, until no cached copy it targets can still
// be served: PAGE_CACHE_TTL plus stale-while-revalidate (720 s by default). Then it expires, counted in `expired`.
//
// State: { pending, firstAsked, lastAsked, lastSent, attempts, lastCode, expired }.
import { STALE_S } from './page-cache-ttl.mjs';

// One send per gap per site (about 4 a minute), as before #699.
export const PURGE_GAP_MS = 15000;
// After a refusal: one refill of the account bucket (5 a minute is one token per 12 s), then twice, then 48 s.
export const RETRY_MS = [12000, 24000, 48000];
// The one result that is NOT retried: the Pages entrypoint has no ctx.cache on this runtime (local wrangler dev), so
// no purge can ever succeed there. index.js Pages.purge returns { ok: false, error: NO_CACHE_API }. A purge that THREW
// is a different case: index.js catches it as { ok: false, errors: [message] }, and it is retried like a refusal.
export const NO_CACHE_API = 'no cache API';

// How long a pending purge is still worth sending: the longest time a page copy can be served after the change that
// asked for it. index.js reads the TTL as Number(env.PAGE_CACHE_TTL || 120); 0 (or junk) turns the page cache off,
// and then nothing is cached and nothing needs a purge.
export function purgeWindowMs(env) {
	const ttl = Number((env && env.PAGE_CACHE_TTL) || 120);
	return ttl > 0 ? (ttl + STALE_S) * 1000 : 0;
}

// A content change asks for a purge. A purge already pending covers it (coalesced).
export function onAsk(st, now) {
	const s = { ...(st || {}) };
	const coalesced = !!s.pending;
	s.lastAsked = now;
	s.pending = true;
	if (!coalesced || s.firstAsked == null) s.firstAsked = now;
	const alarmAt = coalesced ? null : Math.max(now, (s.lastSent || 0) + PURGE_GAP_MS);
	return { st: s, alarmAt, coalesced };
}

// The alarm fired. 'send' clears pending BEFORE the purge, so a change during the purge asks for the next one;
// `covered` is what this send covers, for onResult. 'expire' drops a purge that no copy needs any more.
export function onDue(st, now, windowMs) {
	const s = { ...(st || {}) };
	if (!s.pending) return { st: s, action: 'none', covered: null };
	if (windowMs <= 0 || now - (s.firstAsked == null ? now : s.firstAsked) > windowMs) {
		s.pending = false;
		s.firstAsked = null;
		s.attempts = 0;
		s.expired = (s.expired || 0) + 1;
		return { st: s, action: 'expire', covered: null };
	}
	const covered = { firstAsked: s.firstAsked == null ? now : s.firstAsked, attempts: s.attempts || 0 };
	s.pending = false;
	s.firstAsked = null;
	s.lastSent = now;
	return { st: s, action: 'send', covered };
}

// The result of a send. A refusal re-pends the purge with the OLDEST change it must cover and a back-off.
export function onResult(st, now, r, covered) {
	const s = { ...(st || {}) };
	if (r && r.ok) {
		s.attempts = 0;
		s.lastCode = null;
		return { st: s, alarmAt: null, outcome: 'ok' };
	}
	// No cache API on this runtime: nothing can ever purge, so it is dropped (deliberate, #699 review). Only this exact
	// marker drops; any other error, a thrown purge included, falls through and is retried with the back-off.
	if (r && r.error === NO_CACHE_API) {
		s.attempts = 0;
		return { st: s, alarmAt: null, outcome: 'unavailable' };
	}
	const c = covered || { firstAsked: now, attempts: 0 };
	s.attempts = (c.attempts || 0) + 1;
	const e = r && Array.isArray(r.errors) && r.errors[0];
	s.lastCode = e && typeof e === 'object' && e.code != null ? e.code : null;
	// A change made while this purge was out asked again (pending, a later firstAsked): keep the older one.
	s.firstAsked = s.pending && s.firstAsked != null ? Math.min(s.firstAsked, c.firstAsked) : c.firstAsked;
	s.pending = true;
	const alarmAt = now + RETRY_MS[Math.min(s.attempts - 1, RETRY_MS.length - 1)];
	return { st: s, alarmAt, outcome: 'refused' };
}
