/*
 * Turnstile on the WooCommerce CLASSIC (shortcode) checkout (issue #400, #958).
 * php/turnstile-forms.php prints the widget box on woocommerce_checkout_after_order_review.
 * That hook is inside form.checkout and outside #order_review. update_order_review replaces
 * #order_review only, so the box and its token survive an address change. The script tag is
 * printed once after the form, with window.skyphusionTurnstileClassic set first:
 *   { sitekey, action }
 * It is a classic script, not a module. No build step.
 *
 * Render is explicit (api.js?render=explicit&onload=...). The widget writes the
 * cf-turnstile-response input into the box, inside the checkout form, so the token posts
 * with the rest of the form.
 *
 * Place order stays disabled until that input has a token. A click during the first solve
 * waits. Playwright waits for an enabled button, so the upstream checkout specs do too.
 * If a submit still arrives with an empty token (the Enter key), checkout_place_order
 * returns false and the button is clicked again when the token arrives.
 *
 * A token is single use. After a failed Place order (checkout_error), the widget is reset
 * so the next try gets a fresh token.
 */
(function () {
	'use strict';
	var cfg = window.skyphusionTurnstileClassic || {};
	var BOX = '.skyphusion-turnstile-classic';
	var widgetId = null;
	var widgetBox = null;
	var held = false;

	function api() {
		var t = window.turnstile;
		return t && typeof t.render === 'function' ? t : null;
	}

	function attached(el) {
		return !!el && (typeof el.isConnected === 'boolean' ? el.isConnected : document.documentElement.contains(el));
	}

	function tokenValue() {
		var box = document.querySelector(BOX);
		if (!box || typeof box.querySelector !== 'function') return '';
		var input = box.querySelector('input[name="cf-turnstile-response"]');
		return input && input.value ? String(input.value) : '';
	}

	function placeButton() {
		if (typeof document.getElementById !== 'function') return null;
		return document.getElementById('place_order');
	}

	function syncButton() {
		var btn = placeButton();
		if (!btn) return;
		btn.disabled = !tokenValue();
	}

	function onToken() {
		syncButton();
		if (!held || !tokenValue()) return;
		held = false;
		var btn = placeButton();
		if (btn) btn.click();
	}

	function ensure() {
		var t = api();
		if (!t) return;
		var box = document.querySelector(BOX);
		if (!box) return;
		if (widgetId !== null && box === widgetBox && attached(widgetBox)) {
			syncButton();
			return;
		}
		if (widgetId !== null && typeof t.remove === 'function') {
			try { t.remove(widgetId); } catch (e) { /* the old box is gone already */ }
		}
		widgetId = null;
		widgetBox = null;
		widgetId = t.render(box, {
			sitekey: box.getAttribute('data-sitekey') || cfg.sitekey,
			action: box.getAttribute('data-action') || cfg.action,
			callback: onToken,
		});
		widgetBox = box;
		syncButton();
	}

	function reset() {
		var t = api();
		if (!t) return;
		if (widgetId !== null && attached(widgetBox) && typeof t.reset === 'function') {
			t.reset(widgetId);
			syncButton();
			return;
		}
		ensure();
	}

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
		$(document.body).on('checkout_place_order', function () {
			if (tokenValue()) return;
			held = true;
			return false;
		});
	}

	window.skyphusionTurnstileClassicReady = function () { ensure(); };
	bind();
	if (api()) ensure();

	window.skyphusionTurnstileClassicInternals = { ensure: ensure, reset: reset, bind: bind };
})();
