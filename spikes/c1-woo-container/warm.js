// Warm start (issue #73): start the container on a product view, so the first
// cart after a sleep does not wait for the cold start. The page itself still
// comes from the edge cache; nothing here makes the shopper wait.
//
// WARM_START   off (default) or product
// WARM_GAP_S   no new start within this many seconds of the last (default 60)
// WARM_PATHS   a regular expression for product-view paths (default below)
//
// The start goes through the Container class start() (the container process,
// not a WordPress request), never through Store.prototype.fetch, so the
// bounded queue (#39) does not count or shed it. The container's own idle
// watchdog (IDLE_SECONDS) stops a container that no shopper follows.

export const DEFAULT_WARM_PATHS = '^/(product|shop|product-category|product-tag)(/|$)';

// A product view: WooCommerce's default permalinks, or ?product= / ?post_type=product.
export function isProductView(url, paths) {
	let re;
	try {
		re = new RegExp(paths || DEFAULT_WARM_PATHS);
	} catch {
		re = new RegExp(DEFAULT_WARM_PATHS);
	}
	return re.test(url.pathname) || url.searchParams.has('product') || url.searchParams.get('post_type') === 'product';
}

function gapMs(env) {
	const s = Number(env.WARM_GAP_S ?? 60);
	return (Number.isFinite(s) && s >= 0 ? s : 60) * 1000;
}

// The gateway isolate asks the object at most once per WARM_GAP_S, so a warm
// site costs no RPC per page view.
let gatewayLast = 0;
export function gatewayMayWarm(env, now = Date.now()) {
	if (env.WARM_START !== 'product') return false;
	if (gatewayLast && now - gatewayLast < gapMs(env)) return false;
	gatewayLast = now;
	return true;
}
export function resetGatewayForTests() {
	gatewayLast = 0;
}

// In the Store object. obj is the Store (ctx.container, start(), env).
export async function warmStart(obj, now = Date.now()) {
	const w = (obj.warm ||= { starts: 0, skipped_running: 0, skipped_gap: 0, failed: 0, last: 0, last_error: null });
	if (obj.ctx.container.running) {
		w.skipped_running++;
		return { started: false, reason: 'running' };
	}
	if (w.last && now - w.last < gapMs(obj.env)) {
		w.skipped_gap++;
		return { started: false, reason: 'gap' };
	}
	w.last = now;
	try {
		await obj.start();
		w.starts++;
		return { started: true };
	} catch (e) {
		w.failed++;
		w.last_error = String((e && e.message) || e);
		return { started: false, reason: 'error', error: w.last_error };
	}
}

// For /_store-info.
export function warmInfo(obj, env, now = Date.now()) {
	const w = obj.warm || { starts: 0, skipped_running: 0, skipped_gap: 0, failed: 0, last: 0, last_error: null };
	return { mode: env.WARM_START || 'off', gap_s: gapMs(env) / 1000, starts: w.starts, skipped_running: w.skipped_running, skipped_gap: w.skipped_gap, failed: w.failed, last_ms_ago: w.last ? now - w.last : null, last_error: w.last_error };
}
