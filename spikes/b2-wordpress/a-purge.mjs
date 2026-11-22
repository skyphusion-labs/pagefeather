// #837: approach A's page-cache purge from the gateway (index.js schedulePurge). Tested in tests/a-purge.test.mjs.
//
// Before: one send per PURGE_GAP_MS per isolate, and a purge the account rate limit refused (code 1134) was logged and
// DROPPED. Under the hlm029 wc suite on cf759hl, 195 of 641 sends were refused (Rollins, #837 issuecomment-7082617222),
// so guest copies could stay old for up to their TTL.
//
// Now a refused purge is never lost. Two routes (aPurgeRoute):
// - 'object': approach A runs a per-site cron object (A_CRON=on, the PHP_RUNTIME binding, a-cron.mjs). The gateway
//   hands each ask to that object's requestPurge(), the same path a b-dosql site uses (#699): the object coalesces the
//   whole site's asks into one send per PURGE_GAP_MS, keeps a refused purge pending in its storage, retries it on its
//   alarm with the back-off (12, 24, 48 s), asks the account purge budget when one is bound (fail-open), and calls
//   the site's own Pages.purge (a Worker purges only its own cache; the object runs in the site's own script).
//   A hand-off that fails falls back to the local route, so the purge is still sent.
// - 'local': no cron object. The isolate keeps the same purge-state.mjs state in memory and retries inside the
//   request's waitUntil, for at most WAITUNTIL_BUDGET_MS. A purge still refused then stays pending, logged as
//   purge-pending, and the isolate's next request sends it (kick). Limit: an isolate evicted while a purge is pending
//   loses it; the copy then ages out within purgeWindowMs, as before.
//
// THE STATED LIMIT (both routes): a guest copy is served after the write that changed it until the first successful
// purge after that write. That purge is retried, never dropped, until purgeWindowMs (PAGE_CACHE_TTL +
// stale-while-revalidate, 120 + 600 = 720 s by default) after the oldest write it covers. Past that no copy rendered
// before the write can still be served, so the purge expires, counted. A copy is never served past its writes for
// longer than purgeWindowMs. With the bucket available, the purge goes out within PURGE_GAP_MS (15 s) of the ask, plus
// one back-off step per refusal.
import { PURGE_GAP_MS, purgeWindowMs, onAsk, onDue, onResult } from './purge-state.mjs';
import { approachACronEnabled } from './a-cron.mjs';
import { rendersInWorker } from './pages-render.mjs';

// A Worker's waitUntil may run about 30 s after the response; the local retries stop short of that.
export const WAITUNTIL_BUDGET_MS = 25000;

export function aPurgeRoute(env) {
	return env && approachACronEnabled(env) && env.PHP_RUNTIME && rendersInWorker(env) ? 'object' : 'local';
}

export function createGatewayPurger({ now = () => Date.now(), sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), log = (o) => console.log(JSON.stringify(o)), dispose = () => {}, env = null } = {}) {
	let st = {};
	let running = false;
	const windowMs = () => purgeWindowMs(env || {});

	// One local run: wait for the due time, send, and on a refusal back off and send again while the waitUntil budget lasts.
	async function runLocal(ctx, startAt) {
		const t0 = now();
		try {
			let at = startAt;
			for (;;) {
				if (at > now()) await sleep(at - now());
				const d = onDue(st, now(), windowMs());
				st = d.st;
				if (d.action === 'expire') {
					log({ m: 'purge-expired', expired: st.expired, where: 'gateway' });
					return;
				}
				if (d.action !== 'send') return;
				let r;
				try {
					r = await ctx.purge();
				} catch (e) {
					r = { ok: false, errors: [String((e && e.message) || e).slice(0, 200)] };
				}
				const ok = !!(r && r.ok);
				const errors = (r && r.errors) || [];
				const error = (r && r.error) || null;
				dispose(r);
				const res = onResult(st, now(), { ok, errors, error }, d.covered);
				st = res.st;
				log({ m: 'purge', sent: 1, ok, errors, attempt: d.covered.attempts + 1, ageMs: now() - d.covered.firstAsked, outcome: res.outcome, where: 'gateway' });
				if (res.alarmAt == null) {
					// Sent (or no cache API). An ask made during the send left it pending: one more run after the gap.
					if (!st.pending) return;
					at = Math.max(now(), (st.lastSent || 0) + PURGE_GAP_MS);
				} else {
					at = res.alarmAt;
				}
				if (at - t0 > WAITUNTIL_BUDGET_MS) {
					log({ m: 'purge-pending', attempts: st.attempts || 0, lastCode: st.lastCode == null ? null : st.lastCode, ageMs: now() - (st.firstAsked == null ? now() : st.firstAsked), where: 'gateway' });
					return;
				}
			}
		} finally {
			running = false;
		}
	}

	function startLocal(ctx, at) {
		if (running) return;
		running = true;
		ctx.waitUntil(runLocal(ctx, at));
	}

	const api = {
		state: () => ({ ...st }),
		// A content change asks for a purge of the whole wp-pages tag.
		// ctx: { waitUntil, purge: () => Promise<{ ok, errors, error }>, handOff?: () => Promise<string> }.
		ask(ctx) {
			if (ctx.handOff && aPurgeRoute(env) === 'object') {
				// No m: purge line here: the object logs the ask (doctor's guard counts each m: purge line once, #688).
				ctx.waitUntil(
					Promise.resolve()
						.then(() => ctx.handOff())
						.then((how) => log({ m: 'purge-handoff', ok: true, how: String(how).slice(0, 20) }))
						.catch((e) => {
							log({ m: 'purge-handoff', ok: false, error: String((e && e.message) || e).slice(0, 200) });
							api.askLocal(ctx, true); // the object never saw it: the ask is logged here
						}),
				);
				return;
			}
			api.askLocal(ctx, true);
		},
		askLocal(ctx, logAsk) {
			const a = onAsk(st, now());
			st = a.st;
			if (logAsk) log({ m: 'purge', asked: 1, coalesced: a.coalesced ? 1 : 0, waitMs: a.alarmAt != null ? a.alarmAt - now() : 0, where: 'gateway' });
			startLocal(ctx, a.alarmAt != null ? a.alarmAt : Math.max(now(), (st.lastSent || 0) + PURGE_GAP_MS));
		},
		// The isolate's next request: a purge left pending by a refusal is sent now (after the gap).
		kick(ctx) {
			if (!st.pending || running) return;
			startLocal(ctx, Math.max(now(), (st.lastSent || 0) + PURGE_GAP_MS));
		},
	};
	return api;
}
