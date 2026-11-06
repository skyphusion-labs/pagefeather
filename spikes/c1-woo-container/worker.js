// Spike C1: WordPress + WooCommerce in a Container. The Worker in front serves
// static files (assets), uploads (R2), storefront pages for visitors with no
// state (the Storefront entrypoint, Workers Cache), and sends everything else to
// one store container. The container's SQLite file is
// replicated to R2 by Litestream. PHP in the container reaches R2, Images and
// the cache purge through worker.internal (an outbound handler); it holds no keys
// for them.
import { Container, ContainerProxy, getContainer } from '@cloudflare/containers';
import { WorkerEntrypoint, cache } from 'cloudflare:workers';

export { ContainerProxy };

export class Store extends Container {
	defaultPort = 80;
	sleepAfter = '15m';
	// A static file: the default health check ("ping") requested "/", a full
	// WordPress render (measured in spike B2).
	pingEndpoint = 'localhost/ping';
	constructor(ctx, env) {
		super(ctx, env);
		// The Worker version this object was built with (version_metadata). The
		// container gets the environment this object built, so an object from an
		// older deploy starts containers with the older settings (seen
		// 2026-11-05: a new image with the OBJECT_CACHE of the deploy before).
		// /_store-info compares it with the Worker's own version; /_store-stop
		// resets the object, so the next request builds it again.
		this.builtVersion = (env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id) || '';
		this.envVars = {
			WP_SALT: env.WP_SALT || '',
			ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
			PUBLIC_HOST: env.PUBLIC_HOST || '',
			R2_UPLOADS: env.MEDIA ? '1' : '',
			CF_IMAGES: env.MEDIA && env.IMAGES ? '1' : '',
			LITESTREAM_ACCESS_KEY_ID: env.LITESTREAM_ACCESS_KEY_ID || '',
			LITESTREAM_SECRET_ACCESS_KEY: env.LITESTREAM_SECRET_ACCESS_KEY || '',
			R2_ENDPOINT: env.R2_ENDPOINT || '',
			R2_BUCKET: env.REPLICA_BUCKET || '',
			REPLICA_PATH: env.REPLICA_PATH || 'store',
			SPIKE_TOKEN: env.SPIKE_TOKEN || '',
			PHP_WORKERS: env.PHP_WORKERS || '2',
			IDLE_SECONDS: env.IDLE_SECONDS || '900',
			OBJECT_CACHE: env.OBJECT_CACHE || 'apcu',
			QUEUE_RUNNER: env.QUEUE_RUNNER || 'local',
			CRON_SECONDS: env.CRON_SECONDS || '60',
		};
	}
}
// Spike: stop the container for durability tests. The Container class stop()
// sends the signal only when this.container.running is true, and it returned
// with the container still running (measured 2026-11-04). This reports the
// flag and signals directly; kill=1 uses destroy() (SIGKILL, like a crash).
// With no container running, a stop has nothing to do: it answers skipped
// instead of the error from signal() (deploy/variants/c1.sh stops once after
// each deploy, and on a new site there is no container yet). The same flag
// once read false for a container that served requests (2026-11-04); then the
// stop is skipped, as signal() failed before. kill=1 still calls destroy().
//
// After the stop, the object resets itself (ctx.abort), so the next request
// builds a new object from the current deploy, with its environment. It waits
// for the container to stop first (up to 30 s; SIGTERM lets Litestream finish
// its sync), and resets only when the container is down.
Store.prototype.storeInfo = async function () {
	const p = this.purgeState || {};
	return {
		do_version: this.builtVersion,
		running: this.ctx.container.running,
		object_cache: this.envVars.OBJECT_CACHE,
		replica_path: this.envVars.REPLICA_PATH,
		purge: { sent: p.sent || 0, deferred: p.deferred || 0, failed: p.failed || 0, retried: p.retried || 0, pending: !!p.timer, last_ms_ago: p.last ? Date.now() - p.last : null, last_error: p.lastError || '' },
	};
};
Store.prototype.shutdownNow = async function (kill) {
	const running = this.ctx.container.running;
	const out = { running, kill: !!kill, ok: true, do_version: this.builtVersion };
	try {
		if (!running && !kill) out.skipped = 'no container running';
		else if (kill) await this.ctx.container.destroy();
		else this.ctx.container.signal(15);
	} catch (e) {
		out.ok = false;
		out.error = String((e && e.message) || e);
	}
	const t0 = Date.now();
	while (this.ctx.container.running && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 250));
	out.stopped_after_ms = Date.now() - t0;
	out.still_running = this.ctx.container.running;
	// Reset only when the container is down: an abort while it still runs can
	// cut Litestream's final sync. Still running after 30 s: no reset, ok false,
	// so c1_check fails loudly instead.
	if (out.still_running) {
		out.ok = false;
		out.reset = false;
		return out;
	}
	out.reset = true;
	// After the reply (200 ms): abort() ends this object at once.
	setTimeout(() => this.ctx.abort('reset after /_store-stop'), 200);
	return out;
};

Store.outboundByHost = {
	'worker.internal': async (request, env) => {
		const m = JSON.parse(await request.text());
		if (env.TRACE) console.log('op', m.r2 ? m.r2.op + ' ' + (m.r2.key || m.r2.prefix || m.r2.src || '') : JSON.stringify(m).slice(0, 80));
		let reply = { ok: false, error: 'unknown message' };
		if (m.r2) reply = await r2op(env, m.r2);
		else if (m.cache === 'purge') {
			// The page cache belongs to the Storefront entrypoint, and a purge
			// reaches only the cache of the entrypoint that calls it. This handler
			// runs in ContainerProxy, so it asks the Store object, which calls
			// Storefront.purge() through ctx.exports.
			try {
				reply = await store(env).purgeStorefront();
			} catch (e) {
				reply = { ok: false, error: String((e && e.message) || e) };
			}
		}
		return Response.json(reply);
	},
};

const store = (env) => getContainer(env.STORE, 'store');

// Purges are coalesced: at most one per PURGE_INTERVAL_MS (15 s) for this site.
// The purge limit is 5 a minute (25 at once) per account, for all sites, and a
// burst of admin saves (an import, a bulk edit through the REST API) asked for
// about 30 a minute (measured 2026-11-06 with the gate scripts: 106 in 7
// minutes, and the later ones were refused). A purge asked for inside the
// interval runs at its end, once; a refused purge is tried again once after an
// interval. All purges are of the one tag wp-pages, so coalescing loses nothing.
// The page cache TTL is the backstop when a purge still fails, or when the
// object is reset before a deferred purge runs.
Store.prototype.purgeStorefront = async function () {
	const gap = Number(this.env.PURGE_INTERVAL_MS || 15000);
	const p = (this.purgeState ||= { last: 0, timer: null, sent: 0, deferred: 0, failed: 0, retried: 0, lastError: '' });
	const wait = p.last + gap - Date.now();
	if (wait <= 0 && !p.timer) return this.runPurge(false);
	p.deferred++;
	if (!p.timer) p.timer = setTimeout(() => this.runPurge(false), Math.max(wait, 0));
	return { ok: true, deferred_ms: Math.max(wait, 0) };
};
Store.prototype.runPurge = async function (isRetry) {
	const gap = Number(this.env.PURGE_INTERVAL_MS || 15000);
	const p = this.purgeState;
	p.timer = null;
	p.last = Date.now();
	let r;
	try {
		r = await this.ctx.exports.Storefront.purge(['wp-pages']);
	} catch (e) {
		r = { ok: false, errors: [String((e && e.message) || e)] };
	}
	if (r.ok) {
		p.sent++;
	} else {
		p.failed++;
		p.lastError = JSON.stringify(r.errors || []).slice(0, 300);
		if (!isRetry && !p.timer) {
			p.retried++;
			p.timer = setTimeout(() => this.runPurge(true), gap);
		}
	}
	return r;
};

// Storefront pages for visitors with no state, cached at the edge (issue #58).
// The default entrypoint (the gateway, not cached) decides by the request:
// GET or HEAD, no cookie that carries state, not a cart, checkout, account,
// admin or API path. Then it calls this entrypoint WITHOUT the Cookie header,
// so the cache key is the path and query alone (Workers Caching, cache keys).
// Before this, the default entrypoint itself was cached with Vary: Cookie, and
// a cookie that carries no state (WooCommerce order attribution sets sbjs_*
// cookies in the browser) made every visitor a separate variant: no hits.
export class Storefront extends WorkerEntrypoint {
	async fetch(req) {
		const r = await store(this.env).fetch(req);
		const out = new Response(r.body, r);
		const cc = r.headers.get('cache-control') || '';
		const ok = [200, 301, 404].includes(r.status) && !r.headers.has('set-cookie') && !/no-cache|no-store|private/i.test(cc);
		if (ok) {
			// The edge keeps it for PAGE_CACHE_TTL and serves it stale for up to
			// PAGE_CACHE_SWR while it renders a new copy. The browser does not keep
			// it (no-cache): the next page view after an add to cart must come
			// from the gateway again.
			const ttl = Number(this.env.PAGE_CACHE_TTL || 120);
			const swr = Number(this.env.PAGE_CACHE_SWR || 600);
			out.headers.set('cloudflare-cdn-cache-control', `max-age=${ttl}, stale-while-revalidate=${swr}`);
			out.headers.set('cache-tag', 'wp-pages');
			out.headers.set('cache-control', 'no-cache');
		} else {
			out.headers.set('cloudflare-cdn-cache-control', 'no-store');
			if (!cc) out.headers.set('cache-control', 'private, no-store');
		}
		return out;
	}
	// An RPC method: not cached; the purge reaches this entrypoint's cache.
	async purge(tags) {
		const r = await (this.ctx.cache || cache).purge({ tags });
		return { ok: !!(r && r.success !== false), errors: (r && r.errors) || [] };
	}
}

// Cookies that mean the visitor has state: logged in, a password post, a
// comment author, or any WooCommerce cookie (cart, session, recently viewed).
// Other cookies (order attribution sbjs_*, analytics) do not change the page.
const STATE_COOKIE = /^(wordpress_logged_in_|wordpress_sec_|wp-postpass_|comment_author_|wp-settings-|woocommerce_|wp_woocommerce_session_)/;
const NO_CACHE_PATH = /^\/(wp-admin|wp-login\.php|wp-json|wp-cron\.php|wp-comments-post\.php|cart|checkout|my-account|wc-api|_)/;
const NO_CACHE_PARAM = ['rest_route', 'wc-ajax', 'add-to-cart', 'preview', 'nocache', 'customize_changeset_uuid', 'wc-api'];
function hasState(req) {
	const c = req.headers.get('cookie');
	if (!c) return false;
	return c.split(';').some((x) => STATE_COOKIE.test(x.trim()));
}
function storefrontCacheable(req, url) {
	return (req.method === 'GET' || req.method === 'HEAD') && !hasState(req) && !NO_CACHE_PATH.test(url.pathname) && !NO_CACHE_PARAM.some((k) => url.searchParams.has(k));
}

export default {
	async fetch(req, env, ctx) {
		const url = new URL(req.url);
		const spikeOk = env.SPIKE_TOKEN && req.headers.get('x-spike-token') === env.SPIKE_TOKEN;
		if (url.pathname === '/_store-stop') {
			if (!spikeOk) return new Response('forbidden', { status: 403 });
			try {
				return Response.json(await store(env).shutdownNow(url.searchParams.get('kill') === '1'));
			} catch (e) {
				return Response.json({ ok: false, rpc_error: String((e && e.message) || e) }, { status: 500 });
			}
		}
		if (url.pathname === '/_store-info') {
			if (!spikeOk) return new Response('forbidden', { status: 403 });
			const worker_version = (env.CF_VERSION_METADATA && env.CF_VERSION_METADATA.id) || '';
			try {
				const i = await store(env).storeInfo();
				return Response.json({ worker_version, ...i, current: !!worker_version && worker_version === i.do_version });
			} catch (e) {
				// An object from a deploy before this code has no storeInfo(): not current.
				// (On Cloudflare a sync method named info answered "The RPC receiver
				// does not implement the method info" from an object that did run this
				// code: its shutdownNow answered with this version, 2026-11-05. Local
				// workerd 4.107.0 accepted it. So this one is async and has another
				// name, like shutdownNow, which works; which of the two mattered is
				// not known.)
				return Response.json({ worker_version, current: false, rpc_error: String((e && e.message) || e) });
			}
		}
		if (url.pathname === '/xmlrpc.php') return new Response('XML-RPC is off', { status: 403 });
		// 20 MB: the Images binding input limit, and far above any post or form.
		if (Number(req.headers.get('content-length') || 0) > Number(env.MAX_BODY_BYTES || 20 * 1024 * 1024)) return new Response('request body too large', { status: 413 });
		if (env.MEDIA && (req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/wp-content/uploads/')) return serveUpload(req, env, url);
		if (storefrontCacheable(req, url)) {
			const h = new Headers(req.headers);
			h.delete('cookie');
			return ctx.exports.Storefront.fetch(new Request(req, { headers: h }));
		}
		const r = await store(env).fetch(req);
		if (r.headers.get('cache-control')) return r;
		const out = new Response(r.body, r);
		out.headers.set('cache-control', 'private, no-store');
		return out;
	},
};

async function serveUpload(req, env, url) {
	let key;
	try {
		key = 'uploads/' + decodeURIComponent(url.pathname.slice('/wp-content/uploads/'.length));
	} catch {
		return new Response('bad path', { status: 400 });
	}
	if (new TextEncoder().encode(key).length > 1024) return new Response('not found', { status: 404 });
	let o;
	try {
		o = await env.MEDIA.get(key, { onlyIf: req.headers, range: req.headers });
	} catch {
		return new Response('bad range', { status: 416 });
	}
	if (o === null) return new Response('not found', { status: 404 });
	const h = new Headers();
	o.writeHttpMetadata(h);
	h.set('etag', o.httpEtag);
	h.set('cache-control', 'private, max-age=86400');
	h.set('accept-ranges', 'bytes');
	h.set('x-content-type-options', 'nosniff');
	if (!('body' in o) || !o.body) return new Response(null, { status: 304, headers: h });
	let status = 200;
	let length = o.size;
	if (o.range && req.headers.has('range')) {
		const offset = o.range.offset ?? (o.range.suffix !== undefined ? o.size - o.range.suffix : 0);
		length = o.range.length ?? (o.range.suffix !== undefined ? o.range.suffix : o.size - offset);
		h.set('content-range', `bytes ${offset}-${offset + length - 1}/${o.size}`);
		status = 206;
	}
	h.set('content-length', String(length));
	return new Response(req.method === 'HEAD' ? null : o.body, { status, headers: h });
}

// R2 and Images operations for the R2 Uploads mu-plugin (same protocol as B2).
async function r2op(env, op) {
	try {
		const B = env.MEDIA;
		if (op.op === 'get') {
			const o = await B.get(op.key, op.length ? { range: { offset: op.offset || 0, length: op.length } } : undefined);
			if (!o) return { ok: true, found: false };
			return { ok: true, found: true, body: b64encode(new Uint8Array(await o.arrayBuffer())), size: o.size, mtime: Math.floor(o.uploaded.getTime() / 1000) };
		}
		if (op.op === 'head') {
			const o = await B.head(op.key);
			return o ? { ok: true, found: true, size: o.size, mtime: Math.floor(o.uploaded.getTime() / 1000) } : { ok: true, found: false };
		}
		if (op.op === 'put') {
			await B.put(op.key, b64decode(op.body), { httpMetadata: { contentType: op.type || 'application/octet-stream' } });
			return { ok: true };
		}
		if (op.op === 'copy') {
			const o = await B.get(op.from);
			if (!o) return { ok: true, found: false };
			await B.put(op.to, o.body, { httpMetadata: { contentType: op.type || 'application/octet-stream' } });
			if (op.move) await B.delete(op.from);
			return { ok: true, found: true };
		}
		if (op.op === 'delete') {
			await B.delete(op.key);
			return { ok: true };
		}
		if (op.op === 'list') {
			const l = await B.list({ prefix: op.prefix, delimiter: '/', limit: op.limit || 1000 });
			return { ok: true, keys: l.objects.map((o) => o.key), prefixes: l.delimitedPrefixes };
		}
		if (op.op === 'info') {
			const o = await B.get(op.key);
			if (!o) return { ok: true, found: false };
			const i = await env.IMAGES.info(o.body);
			return { ok: true, found: true, format: i.format, width: i.width, height: i.height, size: i.fileSize };
		}
		if (op.op === 'image') {
			const bytes = await imageJob(env, op);
			return { ok: true, size: bytes.length, ...(op.body ? { body: b64encode(bytes) } : {}) };
		}
		if (op.op === 'images') {
			const results = await Promise.allSettled((op.jobs || []).map((j) => imageJob(env, j)));
			return { ok: true, failed: results.filter((x) => x.status === 'rejected').map((x) => String(x.reason)) };
		}
		// 'reserve' (atomic file names) used D1 in B2. One store container serves
		// uploads here; the plugin falls back to core's unique names.
		return { ok: false, error: 'unknown r2 op ' + op.op };
	} catch (e) {
		return { ok: false, error: String((e && e.message) || e) };
	}
}

async function imageJob(env, job) {
	const o = await env.MEDIA.get(job.src);
	if (!o) throw new Error('source not found: ' + job.src);
	let h = env.IMAGES.input(o.body);
	for (const t of job.ops || []) h = h.transform(t);
	const out = await h.output({ format: job.format, ...(job.quality ? { quality: job.quality } : {}) });
	const bytes = new Uint8Array(await out.response().arrayBuffer());
	if (job.dest) await env.MEDIA.put(job.dest, bytes, { httpMetadata: { contentType: job.format } });
	return bytes;
}

function b64encode(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(s);
}
function b64decode(str) {
	const s = atob(str);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}
