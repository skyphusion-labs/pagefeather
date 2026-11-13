// node --test tests/turnstile-classic-checkout.test.mjs
// Drives php/turnstile-classic-checkout.js (issue #400) in a vm with a stubbed page (one widget
// box that a "fragment refresh" replaces), a stubbed jQuery event bus and a stubbed Turnstile
// widget. Proves: the widget renders into the box with the box's site key and Spin marker; a
// fragment refresh that replaces the box renders a fresh widget into the new box and removes the
// old one; a refresh that keeps the box does not render twice; the race in #400 (the refresh lands
// before api.js) still ends with a rendered widget; a failed Place order resets the widget. The
// real WooCommerce fragment and the real widget are proven only by the live browser run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../php/turnstile-classic-checkout.js', import.meta.url), 'utf8');
const KEY = '1x00000000000000000000AA';

function world({ jquery = true } = {}) {
	let n = 0;
	const page = { box: null };
	function newBox() {
		const b = {
			n: ++n,
			isConnected: true,
			attrs: { 'data-sitekey': KEY, 'data-action': 'turnstile-spin-v1' },
			getAttribute(k) { return this.attrs[k] ?? null; },
		};
		if (page.box) page.box.isConnected = false;
		page.box = b;
		return b;
	}
	newBox();
	const handlers = {};
	const body = {};
	const $ = (el) => ({
		on(ev, fn) { assert.equal(el, body); (handlers[ev] ||= []).push(fn); },
	});
	const fire = (ev) => (handlers[ev] || []).forEach((fn) => fn());
	const renders = [];
	const removes = [];
	const resets = [];
	const turnstile = {
		render: (el, opts) => { renders.push({ el, opts }); return 'w' + renders.length; },
		remove: (id) => removes.push(id),
		reset: (id) => resets.push(id),
	};
	const document = {
		body,
		documentElement: { contains: (el) => el === page.box },
		querySelector: (sel) => (sel === '.skyphusion-turnstile-classic' ? page.box : null),
	};
	const timers = [];
	const window = { skyphusionTurnstileClassic: { sitekey: KEY, action: 'turnstile-spin-v1' } };
	if (jquery) window.jQuery = $;
	const ctx = { window, document, setTimeout: (fn) => timers.push(fn) };
	vm.createContext(ctx);
	vm.runInContext(SRC, ctx);
	// A Woo fragment refresh: update_order_review replaces the box, then fires updated_checkout.
	const refresh = () => { newBox(); fire('updated_checkout'); };
	return { window, page, turnstile, renders, removes, resets, handlers, fire, refresh, timers, $ };
}

test('api.js onload renders one widget into the box with its site key and Spin marker', () => {
	const w = world();
	w.window.turnstile = w.turnstile;
	w.window.skyphusionTurnstileClassicReady();
	assert.equal(w.renders.length, 1);
	assert.equal(w.renders[0].el, w.page.box);
	assert.equal(w.renders[0].opts.sitekey, KEY);
	assert.equal(w.renders[0].opts.action, 'turnstile-spin-v1');
});

test('a fragment refresh that replaces the box renders a new widget and removes the old one (#400)', () => {
	const w = world();
	w.window.turnstile = w.turnstile;
	w.window.skyphusionTurnstileClassicReady();
	const first = w.page.box;
	w.refresh();
	assert.equal(w.renders.length, 2, 'rendered again into the new box');
	assert.notEqual(w.renders[1].el, first);
	assert.equal(w.renders[1].el, w.page.box);
	assert.deepEqual(w.removes, ['w1'], 'the dead widget is removed');
	w.refresh();
	w.refresh();
	assert.equal(w.renders.length, 4, 'every refresh, not only the first');
	assert.deepEqual(w.removes, ['w1', 'w2', 'w3']);
});

test('an updated_checkout that keeps the box does not render twice', () => {
	const w = world();
	w.window.turnstile = w.turnstile;
	w.window.skyphusionTurnstileClassicReady();
	w.fire('updated_checkout');
	w.fire('updated_checkout');
	assert.equal(w.renders.length, 1);
	assert.deepEqual(w.removes, []);
});

test('the #400 race: the refresh lands before api.js, and api.js onload still renders', () => {
	const w = world();
	w.refresh(); // no turnstile yet: nothing to render with, and no throw
	assert.equal(w.renders.length, 0);
	w.window.turnstile = w.turnstile;
	w.window.skyphusionTurnstileClassicReady();
	assert.equal(w.renders.length, 1);
	assert.equal(w.renders[0].el, w.page.box);
});

test('a failed Place order (checkout_error) resets the widget for a fresh token', () => {
	const w = world();
	w.window.turnstile = w.turnstile;
	w.window.skyphusionTurnstileClassicReady();
	w.fire('checkout_error');
	assert.deepEqual(w.resets, ['w1']);
	assert.equal(w.renders.length, 1);
});

test('a checkout_error after the box was replaced renders a new widget, never resets a dead one', () => {
	const w = world();
	w.window.turnstile = w.turnstile;
	w.window.skyphusionTurnstileClassicReady();
	w.page.box.isConnected = false;
	const b = { isConnected: true, getAttribute: (k) => (k === 'data-sitekey' ? KEY : 'turnstile-spin-v1') };
	w.page.box = b;
	w.fire('checkout_error');
	assert.deepEqual(w.resets, []);
	assert.equal(w.renders.length, 2);
	assert.equal(w.renders[1].el, b);
});

test('the events bind once jQuery appears, not before', () => {
	const w = world({ jquery: false });
	assert.equal(Object.keys(w.handlers).length, 0);
	assert.equal(w.timers.length, 1, 'waits for jQuery');
	w.window.jQuery = w.$;
	w.timers.shift()();
	assert.equal(w.handlers.updated_checkout.length, 1);
	assert.equal(w.handlers.checkout_error.length, 1);
	w.window.skyphusionTurnstileClassicInternals.bind();
	assert.equal(w.handlers.updated_checkout.length, 1, 'never bound twice');
});
