// Spike C1: WordPress + WooCommerce in a Container. The Worker in front serves
// static files (assets), uploads (R2), logged-out pages (Workers Cache), and
// sends everything else to one store container. The container's SQLite file is
// replicated to R2 by Litestream. PHP in the container reaches R2, Images and
// the cache purge through worker.internal (an outbound handler); it holds no keys
// for them.
import { Container, ContainerProxy, getContainer } from '@cloudflare/containers';
import { cache } from 'cloudflare:workers';

export { ContainerProxy };

export class Store extends Container {
	defaultPort = 80;
	sleepAfter = '15m';
	// A static file: the default health check ("ping") requested "/", a full
	// WordPress render (measured in spike B2).
	pingEndpoint = 'localhost/ping';
	constructor(ctx, env) {
		super(ctx, env);
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
		};
	}
}
Store.outboundByHost = {
	'worker.internal': async (request, env) => {
		const m = JSON.parse(await request.text());
		if (env.TRACE) console.log('op', m.r2 ? m.r2.op + ' ' + (m.r2.key || m.r2.prefix || m.r2.src || '') : JSON.stringify(m).slice(0, 80));
		let reply = { ok: false, error: 'unknown message' };
		if (m.r2) reply = await r2op(env, m.r2);
		else if (m.cache === 'purge') {
			try {
				await cache.purge({ tags: ['wp-pages'] });
				reply = { ok: true };
			} catch (e) {
				reply = { ok: false, error: String(e) };
			}
		}
		return Response.json(reply);
	},
};

const store = (env) => getContainer(env.STORE, 'store');

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		const spikeOk = env.SPIKE_TOKEN && req.headers.get('x-spike-token') === env.SPIKE_TOKEN;
		if (url.pathname === '/_store-stop') {
			if (!spikeOk) return new Response('forbidden', { status: 403 });
			await store(env).stop();
			return new Response('stopped');
		}
		if (url.pathname === '/xmlrpc.php') return new Response('XML-RPC is off', { status: 403 });
		if (env.MEDIA && (req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/wp-content/uploads/')) return serveUpload(req, env, url);
		const r = await store(env).fetch(req);
		const out = new Response(r.body, r);
		pageCacheHeaders(req, url, r, out, env);
		return out;
	},
};

// Logged-out GET of a public page: cacheable at the edge (Workers Cache). The
// cookie is not in the cache key, so Vary: Cookie keeps logged-in visitors and
// shoppers with a cart on their own uncached responses.
const WP_COOKIE = /(^|;\s*)(wordpress_logged_in_|wordpress_sec_|wp-postpass_|comment_author_|wp-settings-|woocommerce_|wp_woocommerce_session_)/;
function pageCacheHeaders(req, url, r, out, env) {
	const ttl = Number(env.PAGE_CACHE_TTL || 120);
	const cc = r.headers.get('cache-control') || '';
	const cacheable =
		(req.method === 'GET' || req.method === 'HEAD') &&
		[200, 301, 404].includes(r.status) &&
		!WP_COOKIE.test(req.headers.get('cookie') || '') &&
		!r.headers.has('set-cookie') &&
		!/no-cache|no-store|private/i.test(cc) &&
		!/^\/(wp-admin|wp-login\.php|wp-json|cart|checkout|my-account|_)/.test(url.pathname) &&
		!url.searchParams.has('rest_route') &&
		!url.searchParams.has('wc-ajax') &&
		!url.searchParams.has('preview');
	if (cacheable) {
		out.headers.set('cache-control', `public, max-age=${ttl}, stale-while-revalidate=600`);
		out.headers.set('cache-tag', 'wp-pages');
		out.headers.append('vary', 'Cookie');
	} else if (!cc) {
		out.headers.set('cache-control', 'private, no-store');
	}
}

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
