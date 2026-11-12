// node --test tests/turnstile-block-checkout.test.mjs
// Drives php/turnstile-block-checkout.js (issue #308) in a vm with a stubbed WooCommerce checkout
// store (wp.data) and a stubbed Turnstile widget. Proves: the widget renders once into the box
// with the site key and the Spin marker; a solved widget puts the token in the store as extension
// data under the namespace; an expired widget clears it; a checkout POST that fails clears the
// token and resets the widget; a completed checkout does not; a second start does not subscribe
// twice. The real store and widget are proven only by the live run on a block checkout store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../php/turnstile-block-checkout.js', import.meta.url), 'utf8');

function world({ setter = 'setExtensionData', storeReady = true } = {}) {
	const ext = [];
	const subs = [];
	const state = { processing: false, complete: false, error: false };
	const actions = {};
	actions[setter] = (ns, data, replace) => ext.push({ ns, data: { ...data }, replace });
	const sel = {
		isProcessing: () => state.processing,
		isComplete: () => state.complete,
		hasError: () => state.error,
	};
	const wp = {
		data: {
			select: (k) => (k === 'wc/store/checkout' && storeReady ? sel : undefined),
			dispatch: (k) => (k === 'wc/store/checkout' ? actions : undefined),
			subscribe: (fn) => subs.push(fn),
		},
	};
	const renders = [];
	const resets = [];
	const turnstile = {
		render: (el, opts) => { renders.push({ el, opts }); return 'w1'; },
		reset: (id) => resets.push(id),
	};
	const box = { id: 'skyphusion-turnstile-block' };
	const window = {
		wp,
		skyphusionTurnstileBlock: { sitekey: '1x00000000000000000000AA', namespace: 'skyphusion-turnstile', action: 'turnstile-spin-v1' },
	};
	const document = { getElementById: (id) => (id === box.id ? box : null) };
	const ctx = { window, document, setTimeout: () => 0 };
	vm.createContext(ctx);
	vm.runInContext(SRC, ctx);
	const tick = () => subs.forEach((fn) => fn());
	return { window, turnstile, ext, subs, state, renders, resets, box, tick };
}

const NS = 'skyphusion-turnstile';
const last = (ext) => ext[ext.length - 1];

test('api.js onload renders one widget into the box with the site key and Spin marker', () => {
	const w = world();
	w.window.turnstile = w.turnstile;
	w.window.skyphusionTurnstileBlockReady();
	assert.equal(w.renders.length, 1);
	assert.equal(w.renders[0].el, w.box);
	assert.equal(w.renders[0].opts.sitekey, '1x00000000000000000000AA');
	assert.equal(w.renders[0].opts.action, 'turnstile-spin-v1');
	assert.deepEqual(last(w.ext), { ns: NS, data: { token: '' }, replace: true }, 'starts with an empty token');
});

test('a solved widget stores the token as extension data; an expired widget clears it', () => {
	const w = world();
	w.window.turnstile = w.turnstile;
	w.window.skyphusionTurnstileBlockReady();
	w.renders[0].opts.callback('tok-1');
	assert.deepEqual(last(w.ext), { ns: NS, data: { token: 'tok-1' }, replace: true });
	w.renders[0].opts['expired-callback']();
	assert.deepEqual(last(w.ext).data, { token: '' });
	w.renders[0].opts.callback('tok-2');
	w.renders[0].opts['error-callback']();
	assert.deepEqual(last(w.ext).data, { token: '' });
});

test('a checkout POST that fails clears the token and resets the widget', () => {
	const w = world();
	w.window.turnstile = w.turnstile;
	w.window.skyphusionTurnstileBlockReady();
	w.renders[0].opts.callback('tok-1');
	w.state.processing = true; w.tick();
	w.state.processing = false; w.state.error = true; w.tick();
	assert.deepEqual(w.resets, ['w1']);
	assert.deepEqual(last(w.ext).data, { token: '' });
});

test('a completed checkout does not reset the widget', () => {
	const w = world();
	w.window.turnstile = w.turnstile;
	w.window.skyphusionTurnstileBlockReady();
	w.renders[0].opts.callback('tok-1');
	w.state.processing = true; w.tick();
	w.state.processing = false; w.state.complete = true; w.tick();
	assert.deepEqual(w.resets, []);
	assert.deepEqual(last(w.ext).data, { token: 'tok-1' });
});

test('a second start does not render or subscribe twice', () => {
	const w = world();
	w.window.turnstile = w.turnstile;
	w.window.skyphusionTurnstileBlockReady();
	w.window.skyphusionTurnstileBlockReady();
	assert.equal(w.renders.length, 1);
	assert.equal(w.subs.length, 1);
});

test('the deprecated __internalSetExtensionData is used when setExtensionData is missing', () => {
	const w = world({ setter: '__internalSetExtensionData' });
	w.window.turnstile = w.turnstile;
	w.window.skyphusionTurnstileBlockReady();
	w.renders[0].opts.callback('tok-old');
	assert.deepEqual(last(w.ext), { ns: NS, data: { token: 'tok-old' }, replace: true });
});

test('nothing renders before the checkout store exists', () => {
	const w = world({ storeReady: false });
	w.window.turnstile = w.turnstile;
	w.window.skyphusionTurnstileBlockReady();
	assert.equal(w.renders.length, 0);
	assert.equal(w.ext.length, 0);
});
