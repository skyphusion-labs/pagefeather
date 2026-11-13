/*
 * Turnstile on the WooCommerce CLASSIC (shortcode) checkout (issue #400). php/turnstile-forms.php
 * prints the widget box inside the payment fragment (woocommerce_review_order_before_submit), so it
 * stays beside the Place order button, and prints a script tag for this file after the checkout
 * form, with window.skyphusionTurnstileClassic set first:
 *   { sitekey, action }
 * It is a classic script, not a module. No build step.
 *
 * Why explicit render: the Woo checkout script fires update_order_review on load and on every
 * address or shipping change, and replaces #order_review (which holds the box) with fresh HTML.
 * With implicit render, nothing renders the new, empty box, and the shopper sees no challenge. So
 * this script renders the widget into the box in explicit mode (api.js?render=explicit&onload=...),
 * and renders it again after every fragment refresh (the updated_checkout event), when the box on
 * the page is not the one that holds the widget. The widget writes the cf-turnstile-response input
 * into the box, inside form.checkout, so the token posts with the rest of the form, as before.
 *
 * A token is single use: siteverify accepts it once. After a failed Place order (the
 * checkout_error event: a failed challenge, a declined card, a missing field), the widget is reset,
 * so the next try gets a fresh token. A stale token is never sent.
 */
(function () {
	'use strict';
	var cfg = window.skyphusionTurnstileClassic || {};
	var BOX = '.skyphusion-turnstile-classic';
	var widgetId = null;
	var widgetBox = null;

	function api() {
		var t = window.turnstile;
		return t && typeof t.render === 'function' ? t : null;
	}

	// The box is on the page when the document still contains it. A replaced fragment detaches
	// the old box, so its widget is gone with it.
	function attached(el) {
		return !!el && (typeof el.isConnected === 'boolean' ? el.isConnected : document.documentElement.contains(el));
	}

	// Render into the current box unless the widget is already in it. A widget whose box was
	// replaced is removed first, so Turnstile does not keep a dead instance.
	function ensure() {
		var t = api();
		if (!t) return;
		var box = document.querySelector(BOX);
		if (!box) return;
		if (widgetId !== null && box === widgetBox && attached(widgetBox)) return;
		if (widgetId !== null && typeof t.remove === 'function') {
			try { t.remove(widgetId); } catch (e) { /* the old box is gone already */ }
		}
		widgetId = null;
		widgetBox = null;
		widgetId = t.render(box, {
			sitekey: box.getAttribute('data-sitekey') || cfg.sitekey,
			action: box.getAttribute('data-action') || cfg.action,
		});
		widgetBox = box;
	}

	// After a failed Place order: the token was spent (or never valid), so get a fresh one. If the
	// box was replaced in the meantime, render a new widget instead.
	function reset() {
		var t = api();
		if (!t) return;
		if (widgetId !== null && attached(widgetBox) && typeof t.reset === 'function') {
			t.reset(widgetId);
			return;
		}
		ensure();
	}

	// The Woo checkout events are jQuery events on document.body. jQuery loads before the Woo
	// checkout script, but wait for it rather than assume the order.
	var bound = false;
	var tries = 0;
	function bind() {
		if (bound) return;
		var $ = window.jQuery;
		if (!$ || !document.body) {
			if (++tries < 200) setTimeout(bind, 50);
			return;
		}
		bound = true;
		$(document.body).on('updated_checkout', ensure);
		$(document.body).on('checkout_error', reset);
	}

	// api.js calls this when it is ready (onload=). If it was ready first, render now.
	window.skyphusionTurnstileClassicReady = function () { ensure(); };
	bind();
	if (api()) ensure();

	// For tests: the internal steps, so a stubbed page and widget can drive them.
	window.skyphusionTurnstileClassicInternals = { ensure: ensure, reset: reset, bind: bind };
})();
