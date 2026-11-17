// pf-purge-budget (#699 part B; the lead's ruling, 2026-11-16): the ONE purge budget of an account. Each site's Worker
// (deploy/wfp user Workers, and deploy.sh sites) binds the PurgeBudget class here with script_name, and asks for a token
// before it purges (spikes/b2-wordpress/purge-budget-client.mjs). The #699 probe showed a WfP user Worker may hold that
// binding (issuecomment-6929723018).
//
// One object, named 'account', holds the state. Its methods run one at a time (the object's input gate), so a get, the
// rules, and a put are one step. The rules are budget-state.mjs, tested there. No public route: fetch answers 404.
import { DurableObject } from 'cloudflare:workers';
import { acquire, refused } from './budget-state.mjs';

const KEY = 'budget';
// A site is named by its own host (SITE_ORIGIN). Anything else is refused as a name, and the client fails open.
const SITE = /^[a-z0-9.-]{1,253}$/i;

export class PurgeBudget extends DurableObject {
	async acquire(site) {
		if (typeof site !== 'string' || !SITE.test(site)) return { grant: null, error: 'bad site name' };
		const r = acquire(await this.ctx.storage.get(KEY), site, Date.now());
		await this.ctx.storage.put(KEY, r.st);
		console.log(JSON.stringify({ m: 'purge-budget', site, grant: r.grant, waitMs: r.grant ? 0 : r.retryAt - Date.now(), queued: r.st.queue.length, tokens: Math.round(r.st.tokens * 100) / 100 }));
		return { grant: r.grant, retryAt: r.retryAt };
	}

	async refused(site) {
		if (typeof site !== 'string' || !SITE.test(site)) return { ok: false };
		const r = refused(await this.ctx.storage.get(KEY), site, Date.now());
		await this.ctx.storage.put(KEY, r.st);
		console.log(JSON.stringify({ m: 'purge-budget', site, refused: 1 }));
		return { ok: true };
	}

	// For an operator's check: the tokens and the queue (site names and times only).
	async state() {
		return (await this.ctx.storage.get(KEY)) || null;
	}
}

export default {
	fetch() {
		return new Response('not found', { status: 404 });
	},
};
