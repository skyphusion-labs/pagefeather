// #699 part B: a site's side of the account purge budget (purge-budget-client.mjs). The site asks pf-purge-budget for
// a token before it purges. FAIL-OPEN (the lead's ruling): with no binding, or a budget that throws, hangs or answers
// nonsense, the site purges as part A does. It never blocks a purge forever.
// Run: node --test spikes/b2-wordpress/tests/purge-budget-client.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET_TIMEOUT_MS, MAX_WAIT_MS, budgetAcquire, budgetRefused } from '../purge-budget-client.mjs';

// A fake PURGE_BUDGET binding: idFromName/get, and a stub whose acquire/refused run `impl`.
function binding(impl) {
	const calls = [];
	return {
		calls,
		idFromName: (n) => ({ name: n }),
		get: (id) => ({
			acquire: async (site) => { calls.push(['acquire', id.name, site]); return impl('acquire', site); },
			refused: async (site) => { calls.push(['refused', id.name, site]); return impl('refused', site); },
		}),
	};
}

test('no binding: local (the site keeps its part A rules)', async () => {
	const r = await budgetAcquire({}, 'a.example', 1000);
	assert.equal(r.via, 'local');
});

test('a grant: send now; ONE budget object per account', async () => {
	const b = binding(() => ({ grant: true, retryAt: null }));
	const r = await budgetAcquire({ PURGE_BUDGET: b }, 'a.example', 1000);
	assert.equal(r.via, 'budget');
	assert.equal(r.grant, true);
	assert.deepEqual(b.calls[0], ['acquire', 'account', 'a.example']);
});

test('a wait: not now, come back at retryAt', async () => {
	const b = binding(() => ({ grant: false, retryAt: 16000 }));
	const r = await budgetAcquire({ PURGE_BUDGET: b }, 'a.example', 1000);
	assert.equal(r.via, 'budget');
	assert.equal(r.grant, false);
	assert.equal(r.retryAt, 16000);
});

test('a wait past MAX_WAIT_MS is capped: a budget bug cannot stall a site', async () => {
	const b = binding(() => ({ grant: false, retryAt: 1000 + 10 * 60000 }));
	const r = await budgetAcquire({ PURGE_BUDGET: b }, 'a.example', 1000);
	assert.equal(r.retryAt, 1000 + MAX_WAIT_MS);
	assert.equal(MAX_WAIT_MS, 60000);
});

test('fail-open: the budget throws', async () => {
	const b = binding(() => { throw new Error('Durable Object reset'); });
	const r = await budgetAcquire({ PURGE_BUDGET: b }, 'a.example', 1000);
	assert.equal(r.via, 'fail-open');
	assert.match(r.error, /reset/);
});

// Its own timeout: a client with no timeout must FAIL this test, not hang the suite.
test('fail-open: the budget hangs past BUDGET_TIMEOUT_MS', { timeout: 3000 }, async () => {
	const b = binding(() => new Promise(() => {}));
	const t0 = Date.now();
	const r = await budgetAcquire({ PURGE_BUDGET: b }, 'a.example', 1000, 50);
	assert.equal(r.via, 'fail-open');
	assert.match(r.error, /timeout/);
	assert.ok(Date.now() - t0 < 2000, 'it did not wait for the hung call');
	assert.equal(BUDGET_TIMEOUT_MS, 2000);
});

test('fail-open: a nonsense answer (no grant field, or a retryAt in the past)', async () => {
	for (const bad of [null, {}, { grant: 'yes' }, { grant: false, retryAt: 500 }, { grant: false }]) {
		const r = await budgetAcquire({ PURGE_BUDGET: binding(() => bad) }, 'a.example', 1000);
		assert.equal(r.via, 'fail-open', JSON.stringify(bad));
	}
});

test('fail-open: no site name (no SITE_ORIGIN) never calls the budget', async () => {
	const b = binding(() => ({ grant: false, retryAt: 16000 }));
	const r = await budgetAcquire({ PURGE_BUDGET: b }, '', 1000);
	assert.equal(r.via, 'fail-open');
	assert.equal(b.calls.length, 0);
});

test('budgetRefused tells the budget, and never throws', async () => {
	const b = binding(() => ({ ok: true }));
	await budgetRefused({ PURGE_BUDGET: b }, 'a.example');
	assert.deepEqual(b.calls[0], ['refused', 'account', 'a.example']);
	await budgetRefused({ PURGE_BUDGET: binding(() => { throw new Error('x'); }) }, 'a.example');
	await budgetRefused({}, 'a.example');
});
