// #705 review, finding 7: with reuse one WebAssembly.Memory serves several runtimes, and the ledger must count its
// collection ONCE. node --expose-gc --test tests/mem-ledger-identity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLedger } from '../mem-ledger.mjs';

test('one memory registered by two runtimes is one live memory, and collected once', async () => {
	assert.equal(typeof globalThis.gc, 'function', 'run with node --expose-gc');
	const ledger = createLedger();
	(() => {
		const mem = new WebAssembly.Memory({ initial: 16 });
		ledger.register({ id: 'a' }, 1, mem);
		ledger.register({ id: 'b' }, 2, mem);
		const r = ledger.runtimes(2, () => 0);
		assert.equal(r.memLive, 1, 'one memory counted twice');
	})();
	for (let i = 0; i < 10 && ledger.runtimes(-1, () => 0).memCollected === 0; i++) { await new Promise((ok) => setTimeout(ok, 20)); globalThis.gc(); }
	await new Promise((ok) => setTimeout(ok, 50));
	const r = ledger.runtimes(-1, () => 0);
	assert.ok(r.memCollected >= 1, 'the memory was never collected: the test cannot see the count');
	assert.equal(r.memCollected, 1, 'one collection counted ' + r.memCollected + ' times');
});
