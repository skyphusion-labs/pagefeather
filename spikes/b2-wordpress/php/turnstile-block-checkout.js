/*
 * Turnstile on the WooCommerce block checkout (issue #308). php/turnstile-forms.php prints
 * a script tag for this file after the checkout block, with window.skyphusionTurnstileBlock set
 * first:
 *   { sitekey, namespace, action }
 * It is a classic script, not a module. No build step.
 *
 * The block checkout is a React app that posts to the Store API (/wc/store/v1/checkout). A
 * form field never reaches that request, so the token goes as extension data: the checkout
 * store's setExtensionData(namespace, { token }) puts it in the "extensions" member of the POST
 * body, and the PHP gate reads extensions[namespace].token.
 *
 * The widget box is printed by PHP OUTSIDE the React root, so React never removes or moves it.
 * Turnstile renders into it in explicit mode (api.js?render=explicit&onload=...).
 *
 * A token is single use: siteverify accepts it once. So after every checkout POST that does not
 * end the checkout (an error, a declined card, a failed challenge), the widget is reset and the
 * stored token is cleared. An expired or errored widget also clears the token. A stale token is
 * never sent.
 */
(function () {
	'use strict';
	var cfg = window.skyphusionTurnstileBlock || {};
	var STORE = 'wc/store/checkout';
	var widgetId = null;

	function data() {
		var wp = window.wp;
		if (!wp || !wp.data || typeof wp.data.select !== 'function') return null;
		try {
			return wp.data.select(STORE) ? wp.data : null;
		} catch (e) {
			return null;
		}
	}

	// setExtensionData since WooCommerce 9.9; __internalSetExtensionData before it (now deprecated).
	function setToken(token) {
		var d = data();
		if (!d) return false;
		var actions = d.dispatch(STORE);
		var set = actions && (actions.setExtensionData || actions.__internalSetExtensionData);
		if (typeof set !== 'function') return false;
		set(cfg.namespace, { token: token || '' }, true);
		return true;
	}

	function reset() {
		setToken('');
		if (widgetId !== null && window.turnstile && typeof window.turnstile.reset === 'function') {
			window.turnstile.reset(widgetId);
		}
	}

	// Reset after a checkout POST that left the shopper on the page. isProcessing goes true for the
	// POST; when it goes false again and the checkout is not complete, the token was spent.
	function watch() {
		var d = data();
		if (!d || typeof d.subscribe !== 'function') return;
		var was = false;
		d.subscribe(function () {
			var s = d.select(STORE);
			var now = !!(s && typeof s.isProcessing === 'function' && s.isProcessing());
			if (was && !now) {
				var done = typeof s.isComplete === 'function' && s.isComplete();
				if (!done || (typeof s.hasError === 'function' && s.hasError())) reset();
			}
			was = now;
		});
	}

	function render() {
		var box = document.getElementById('skyphusion-turnstile-block');
		if (!box || !window.turnstile || widgetId !== null) return;
		widgetId = window.turnstile.render(box, {
			sitekey: cfg.sitekey,
			action: cfg.action,
			callback: function (token) { setToken(token); },
			'expired-callback': function () { setToken(''); },
			'error-callback': function () { setToken(''); },
		});
	}

	// The checkout store registers when WooCommerce's scripts run. They load in the footer, the
	// same place as this script, so wait for the store before wiring anything to it.
	var tries = 0;
	var started = false;
	function start() {
		if (started) return;
		if (!data()) {
			if (++tries < 200) setTimeout(start, 50);
			return;
		}
		started = true;
		setToken('');
		watch();
		render();
	}

	// api.js calls this when it is ready (onload=). If it was ready first, start now.
	window.skyphusionTurnstileBlockReady = function () { start(); };
	if (window.turnstile) start();

	// For tests: the internal steps, so a stubbed store and widget can drive them.
	window.skyphusionTurnstileBlockInternals = { setToken: setToken, reset: reset, render: render, start: start };
})();
