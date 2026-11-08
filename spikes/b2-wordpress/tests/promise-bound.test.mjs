import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedWait, TIMED_OUT } from '../promise-bound.mjs';

test('a promise that settles within the bound returns its value', async () => {
	const r = await boundedWait(Promise.resolve(3), 1000);
	assert.equal(r, 3);
});

test('a value of 0 is not mistaken for the timeout sentinel', async () => {
	const r = await boundedWait(Promise.resolve(0), 1000);
	assert.equal(r, 0);
	assert.notEqual(r, TIMED_OUT);
});

test('a promise slower than the bound returns TIMED_OUT', async () => {
	// unref the slow timer so the suite can exit without waiting it out.
	const slow = new Promise((resolve) => {
		const t = setTimeout(() => resolve('late'), 5000);
		if (t && typeof t.unref === 'function') t.unref();
	});
	const r = await boundedWait(slow, 10);
	assert.equal(r, TIMED_OUT);
});

test('the timeout does not fire for a promise that already settled', async () => {
	// A large bound: if boundedWait failed to clear the timer the process would
	// stay alive on it; unref is not used here so a leaked timer would be visible.
	let fired = false;
	const orig = globalThis.setTimeout;
	globalThis.setTimeout = (fn, ms) => orig(() => { fired = true; fn(); }, ms);
	try {
		const r = await boundedWait(Promise.resolve('fast'), 50);
		assert.equal(r, 'fast');
		// Give the (cleared) timer a chance to misfire; it must not.
		await new Promise((res) => orig(res, 120));
		assert.equal(fired, false);
	} finally {
		globalThis.setTimeout = orig;
	}
});
