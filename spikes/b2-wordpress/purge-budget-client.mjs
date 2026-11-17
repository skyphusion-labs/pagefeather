// #699 part B: a site's side of the account purge budget, pf-purge-budget (deploy/purge-budget). Before the PHP object
// sends a purge, it asks the budget for a token through its PURGE_BUDGET binding (a Durable Object binding with
// script_name, the lead's ruling; feasible per the #699 probe). Tested in tests/purge-budget-client.test.mjs.
//
// FAIL-OPEN (the ruling): with no binding, or a budget that throws, hangs, or answers nonsense, the site purges as part
// A does (purge-state.mjs). The budget never blocks a purge forever: a wait it names is capped at MAX_WAIT_MS.
//
// budgetAcquire answers one of:
//   { via: 'local' }                          no PURGE_BUDGET binding: part A rules
//   { via: 'budget', grant: true }            send now
//   { via: 'budget', grant: false, retryAt }  not now; keep the purge pending and come back at retryAt
//   { via: 'fail-open', error }               the budget cannot answer: send now, as part A
export const BUDGET_TIMEOUT_MS = 2000;
export const MAX_WAIT_MS = 60000;
// ONE budget object per account.
const BUDGET_OBJECT = 'account';

function stubOf(env) {
	const ns = env && env.PURGE_BUDGET;
	return ns && typeof ns.idFromName === 'function' ? ns.get(ns.idFromName(BUDGET_OBJECT)) : null;
}

function withTimeout(p, ms) {
	let timer;
	return Promise.race([
		p,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error('timeout after ' + ms + ' ms')), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

export async function budgetAcquire(env, site, now = Date.now(), timeoutMs = BUDGET_TIMEOUT_MS) {
	const stub = stubOf(env);
	if (!stub) return { via: 'local' };
	if (typeof site !== 'string' || !site) return { via: 'fail-open', error: 'no site name' };
	let r;
	try {
		r = await withTimeout(Promise.resolve().then(() => stub.acquire(site)), timeoutMs);
	} catch (e) {
		return { via: 'fail-open', error: String((e && e.message) || e).slice(0, 200) };
	}
	if (!r || typeof r.grant !== 'boolean') return { via: 'fail-open', error: 'a nonsense answer' };
	if (r.grant) return { via: 'budget', grant: true };
	if (typeof r.retryAt !== 'number' || !(r.retryAt > now)) return { via: 'fail-open', error: 'a wait with no future retryAt' };
	return { via: 'budget', grant: false, retryAt: Math.min(r.retryAt, now + MAX_WAIT_MS) };
}

// A send that held a token was refused anyway (1134): another user spent the account bucket. Best effort.
export async function budgetRefused(env, site, timeoutMs = BUDGET_TIMEOUT_MS) {
	const stub = stubOf(env);
	if (!stub || typeof site !== 'string' || !site) return;
	try {
		await withTimeout(Promise.resolve().then(() => stub.refused(site)), timeoutMs);
	} catch {
		// fail-open: the budget learns nothing, the site's own back-off still holds
	}
}
