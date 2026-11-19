/*
 * Turnstile on the WooCommerce block checkout (issue #308, #958). php/turnstile-forms.php prints
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
 * Place order stays disabled until the callback has stored a token. The checkout POST closes
 * over the extension data from the last React render, so the button is enabled on a later turn
 * (a 50 ms timer), after that render. A click before the token is stopped.
 *
 * A token is single use. After every checkout POST that does not end the checkout, the widget
 * is reset and the stored token is cleared. An expired or errored widget also clears the token.
 */
(function () {
	'use strict';
	var cfg = window.skyphusionTurnstileBlock || {};
	var STORE = 'wc/store/checkout';
	var BUTTON = '.wc-block-components-checkout-place-order-button';
	var widgetId = null;
	var solved = '';

	function data() {
		var wp = window.wp;
		if (!wp || !wp.data || typeof wp.data.select !== 'function') return null;
		try {
			return wp.data.select(STORE) ? wp.data : null;
		} catch (e) {
			return null;
		}
	}

	function setToken(token) {
		var d = data();
		if (!d) return false;
		var actions = d.dispatch(STORE);
		var set = actions && (actions.setExtensionData || actions.__internalSetExtensionData);
		if (typeof set !== 'function') return false;
		set(cfg.namespace, { token: token || '' }, true);
		return true;
	}

	function placeButton() {
		if (typeof document.querySelector !== 'function') return null;
		return document.querySelector(BUTTON);
	}

	function holdButton() {
		if (solved) return;
		var btn = placeButton();
		if (btn) btn.disabled = true;
	}

	function releaseButton() {
		setTimeout(function () {
			if (!solved) return;
			var btn = placeButton();
			if (btn) btn.disabled = false;
		}, 50);
	}

	function reset() {
		solved = '';
		setToken('');
		holdButton();
		if (widgetId !== null && window.turnstile && typeof window.turnstile.reset === 'function') {
			window.turnstile.reset(widgetId);
		}
	}

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
			callback: function (token) {
				solved = token || '';
				setToken(solved);
				if (solved) releaseButton();
				else holdButton();
			},
			'expired-callback': function () { solved = ''; setToken(''); holdButton(); },
			'error-callback': function () { solved = ''; setToken(''); holdButton(); },
		});
		holdButton();
	}

	if (typeof document.addEventListener === 'function') {
		document.addEventListener('click', function (e) {
			if (solved) return;
			var t = e.target;
			var btn = t && typeof t.closest === 'function' ? t.closest(BUTTON) : null;
			if (!btn) return;
			e.preventDefault();
			e.stopImmediatePropagation();
		}, true);
	}

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

	window.skyphusionTurnstileBlockReady = function () { start(); };
	if (window.turnstile) start();

	window.skyphusionTurnstileBlockInternals = { setToken: setToken, reset: reset, render: render, start: start };
})();
