// Spike B2: WordPress in a Worker, database on D1.
import wasmModule from './vendor/php_8_3.wasm';
import * as loader from './vendor/php_8_3.js';
import { loadPHPRuntime, PHP, PHPRequestHandler, setPhpIniEntries, __private__dont__use } from '@php-wasm/universal';
import { inflateSync } from 'fflate';
import siteZip from './build/site.zip';
// Compiled PHP (OPcache file cache) made by opcache.sh with this same PHP build.
import opcacheZip from './build/opcache.zip';

const OPCACHE_DIR = '/internal/shared/opcache';

const DOCROOT = '/wordpress';
// php-wasm's defaults keep OPcache on with a file cache in PHP's in-memory
// filesystem. That saves recompiling about 500 scripts per request (CPU), at
// the cost of JS memory. Override through PHP_INI.
const INI_DEFAULTS = {};
// WebAssembly memory never shrinks. Past this, boot a fresh runtime for the next request.
// OPcache shared memory (32 MB) is part of it. Measured 2026-11-04 on Paid:
// 81 MiB after the first page with OPcache on.
const RECYCLE_WASM_BYTES = 100 * 1024 * 1024;
let ENV;
// Counters only grow. A request reports the difference, so a nested request
// (WordPress calling its own URL) cannot reset an outer one.
const stats = newStats();
let bootPromise;
// One PHP runtime per isolate, and PHP is not re-entrant. Measured 2026-11-04:
// with 30 parallel requests on one isolate, about half crashed. So requests
// that use PHP run one at a time, in arrival order.
let phpQueue = Promise.resolve();
// If the request ahead never finishes, a waiter would wait forever. On Free a
// request stopped for CPU can leave the isolate alive with the lock held
// (measured 2026-11-04: 524 timeouts). After LOCK_STALE_MS a waiter goes on with
// a new PHP runtime. 60 s: the installer runs about 32 s on Paid.
const LOCK_STALE_MS = 60000;
function withPhp(fn) {
	const prev = phpQueue;
	const run = (async () => {
		let timer;
		const stale = await Promise.race([
			prev.then(
				() => false,
				() => false,
			),
			new Promise((ok) => (timer = setTimeout(() => ok(true), LOCK_STALE_MS))),
		]);
		clearTimeout(timer);
		if (stale) bootPromise = null; // the old runtime's state is unknown
		return fn();
	})();
	phpQueue = run.catch(() => {});
	return run;
}
// D1 keeps a row up to 2 MB. A larger body cannot be stored, and a 4 MB body
// ran the isolate out of memory (measured 2026-11-04). Override with MAX_BODY_BYTES.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
// A media upload can be larger: the Worker stores it in R2 first, and PHP gets
// a small marker (php/r2-uploads.php). 20 MB is the Images binding input limit.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const STAGE_MIN_BYTES = 1024 * 1024;

function isMediaUpload(req, url) {
	if (req.method !== 'POST') return false;
	if (url.pathname === '/wp-admin/async-upload.php' || url.pathname === '/wp-admin/media-new.php') return true;
	const route = url.searchParams.get('rest_route') || (url.pathname.startsWith('/wp-json/') ? url.pathname.slice(8) : '');
	return /^\/wp\/v2\/media\/?$/.test(route);
}

// The type of a file from its first bytes, and whether it looks like markup or code.
function sniff(b) {
	const at = (o, str) => [...str].every((c, i) => b[o + i] === c.charCodeAt(0));
	let type = 'application/octet-stream';
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) type = 'image/jpeg';
	else if (at(0, '\x89PNG')) type = 'image/png';
	else if (at(0, 'GIF8')) type = 'image/gif';
	else if (at(0, 'RIFF') && at(8, 'WEBP')) type = 'image/webp';
	else if (at(4, 'ftyp')) {
		const brand = String.fromCharCode(...b.slice(8, 12));
		type = /avif|avis/.test(brand) ? 'image/avif' : /heic|heix|mif1|msf1/.test(brand) ? 'image/heic' : 'video/mp4';
	} else if (at(0, '%PDF')) type = 'application/pdf';
	const head = new TextDecoder().decode(b.slice(0, 1024)).toLowerCase();
	return { type, dangerous: /<\?php|<script|<html|<!doctype html|<svg/.test(head) };
}

async function stageFile(env, bytes, contentType) {
	const key = 'staging/' + crypto.randomUUID();
	await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: contentType || 'application/octet-stream' } });
	const s = sniff(bytes);
	return new TextEncoder().encode('R2STAGED\n' + JSON.stringify({ key, size: bytes.length, sniffed: s.type, dangerous: s.dangerous }));
}

// Store the file part(s) of a large media upload in R2. Returns the body and
// content type PHP gets instead.
async function stageUpload(req, env) {
	const ct = req.headers.get('content-type') || '';
	if (/^multipart\/form-data/i.test(ct)) {
		const form = await req.formData();
		const out = new FormData();
		for (const [k, v] of form) {
			if (typeof v !== 'string' && v.size > 0) {
				const marker = await stageFile(env, new Uint8Array(await v.arrayBuffer()), v.type);
				out.append(k, new File([marker], v.name, { type: v.type }));
			} else {
				out.append(k, v);
			}
		}
		const res = new Response(out);
		return { body: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') };
	}
	const marker = await stageFile(env, new Uint8Array(await req.arrayBuffer()), ct);
	return { body: marker, contentType: ct };
}

function newStats() {
	return { calls: 0, ms: 0, failures: [], log: [], r2: {} };
}

// Entries of a zip, from its central directory. data() returns the file
// bytes: a view for a stored entry, an inflated copy for a deflated one.
function zipEntries(zip) {
	const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let eocd = zip.length - 22;
	while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
	if (eocd < 0) return [];
	const total = dv.getUint16(eocd + 10, true);
	let p = dv.getUint32(eocd + 16, true);
	const dec = new TextDecoder();
	const out = [];
	for (let n = 0; n < total; n++) {
		if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip central directory');
		const method = dv.getUint16(p + 10, true);
		const csize = dv.getUint32(p + 20, true);
		const size = dv.getUint32(p + 24, true);
		const nlen = dv.getUint16(p + 28, true);
		const xlen = dv.getUint16(p + 30, true);
		const clen = dv.getUint16(p + 32, true);
		const local = dv.getUint32(p + 42, true);
		const name = dec.decode(zip.subarray(p + 46, p + 46 + nlen));
		p += 46 + nlen + xlen + clen;
		out.push({
			name,
			method,
			size,
			data() {
				const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
				const raw = zip.subarray(start, start + csize);
				return method === 0 ? raw : inflateSync(raw, { out: new Uint8Array(size) });
			},
		});
	}
	return out;
}

// A MEMFS file whose contents are made on first read. Its size is known at
// once, so stat() does not inflate it. A write replaces the lazy contents.
function lazyFile(FS, path, entry) {
	FS.writeFile(path, new Uint8Array(0));
	const node = FS.lookupPath(path).node;
	let contents = null;
	let used = entry.size;
	Object.defineProperty(node, 'contents', {
		configurable: true,
		get() {
			if (contents === null) contents = entry.data();
			return contents;
		},
		set(v) {
			contents = v;
		},
	});
	Object.defineProperty(node, 'usedBytes', {
		configurable: true,
		get() {
			return used;
		},
		set(v) {
			used = v;
		},
	});
}

async function boot(origin) {
	const t0 = Date.now();
	const id = await loadPHPRuntime(loader, {
		// PHP_ENV (JSON) sets process environment for PHP, e.g. USE_ZEND_ALLOC.
		ENV: JSON.parse(ENV.PHP_ENV || '{"USE_ZEND_ALLOC":"0"}'),
		instantiateWasm(imports, done) {
			const inst = new WebAssembly.Instance(wasmModule, imports);
			done(inst, wasmModule);
			return inst.exports;
		},
	});
	const php = new PHP(id);
	// php.ini overrides. PHP_INI (a JSON object) lets a deploy or a test change them.
	// A deploy (WP_SALT is set) never prints PHP errors, even for a script that
	// does not load wp-config.php (measured 2026-11-04: /wp-content/db.php did).
	const deployIni = ENV.WP_SALT ? { display_errors: '0', display_startup_errors: '0' } : {};
	// OPcache. Measured 2026-11-04: it cached nothing until these were set.
	// - file_update_protection=0: OPcache skips a file changed in the last 2 s.
	//   Files are written at boot and the Worker clock barely moves, so every
	//   file looked new.
	// - validate_timestamps=0: scripts never change within a deploy, and the
	//   shipped file cache is older than the files unzipped at boot.
	// - shared memory (24 MB) for warm requests, the file cache (shipped by
	//   opcache.sh) for a cold isolate. Warm page locally: 220 ms -> 100 ms.
	const opcacheIni = {
		'opcache.file_update_protection': '0',
		'opcache.validate_timestamps': '0',
		'opcache.file_cache_only': '0',
		'opcache.memory_consumption': '32',
		'opcache.interned_strings_buffer': '4',
		'opcache.max_accelerated_files': '4000',
	};
	await setPhpIniEntries(php, { ...INI_DEFAULTS, ...opcacheIni, ...deployIni, ...JSON.parse(ENV.PHP_INI || '{}') });
	const tWasm = Date.now() - t0;
	const mem = () => php[__private__dont__use].HEAPU8.length;
	const memAt = { start: mem() };

	// Files, without copying at boot (measured 2026-11-04: unzip and write cost
	// about 300 ms of a cold start locally, more on Cloudflare).
	// - site.zip (deflated): each PHP file is inflated on its first read only.
	//   A page reads about a quarter of them.
	// - opcache.zip (stored): each file is a view of the bundled bytes. No copy.
	const FS = php[__private__dont__use].FS;
	const made = new Set();
	const mkdirp = (dir) => {
		if (made.has(dir)) return;
		php.mkdir(dir);
		made.add(dir);
	};
	let count = 0;
	let fileBytes = 0;
	for (const e of zipEntries(new Uint8Array(siteZip))) {
		const full = '/' + e.name;
		if (e.name.endsWith('/')) {
			mkdirp(full.slice(0, -1));
			continue;
		}
		mkdirp(full.slice(0, full.lastIndexOf('/')));
		lazyFile(FS, full, e);
		count++;
		fileBytes += e.size;
	}
	const tSite = Date.now() - t0 - tWasm;
	let opcacheFiles = 0;
	for (const e of zipEntries(new Uint8Array(opcacheZip))) {
		if (e.name.endsWith('/')) continue;
		const full = OPCACHE_DIR + '/' + e.name;
		mkdirp(full.slice(0, full.lastIndexOf('/')));
		if (e.method === 0) FS.writeFile(full, e.data(), { canOwn: true });
		else lazyFile(FS, full, e);
		opcacheFiles++;
	}
	const tFiles = Date.now() - t0 - tWasm;
	memAt.afterFiles = mem();

	// Keys from the WP_SALT secret, so a deployed site never uses the local ones.
	const lines = ['<?php'];
	if (ENV.WP_SALT) {
		for (const k of ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT']) {
			const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ENV.WP_SALT + ':' + k));
			const hex = [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
			lines.push(`define('${k}', '${hex}');`);
		}
	}
	lines.push(`define('WP_HOME', ${JSON.stringify(origin)});`);
	// The R2 Uploads mu-plugin turns on when the MEDIA binding exists.
	if (ENV.MEDIA) lines.push(`define('R2_UPLOADS', true);`);
	// Image sizes come from the Images binding (php/cf-images-editor.php).
	if (ENV.MEDIA && ENV.IMAGES) lines.push(`define('CF_IMAGES', true);`);
	// A deploy (WP_SALT is set) shows no PHP errors or database errors to visitors.
	if (ENV.WP_SALT) lines.push(`define('WP_DEBUG', false);`);
	php.writeFile(DOCROOT + '/wp-runtime.php', lines.join('\n') + '\n');

	php.onMessage(async (raw) => {
		const m = JSON.parse(raw);
		if (m.r2) return JSON.stringify(await r2op(m.r2));
		if (m.cache === 'purge') {
			purgeRequested = true;
			return '{}';
		}
		if (m.report) {
			stats.failures.push({ sql: m.sql.slice(0, 400), error: m.error });
			stats.log.push('ERR ' + m.sql.slice(0, 160).replace(/\s+/g, ' ') + ' => ' + m.error.slice(0, 120));
			return '{}';
		}
		const t = Date.now();
		stats.calls++;
		try {
			const stmt = ENV.DB.prepare(m.sql).bind(...(m.params || []));
			const returnsRows = /^\s*(SELECT|PRAGMA|WITH|VALUES|EXPLAIN)\b/i.test(m.sql) || /\bRETURNING\b/i.test(m.sql);
			let reply;
			if (returnsRows) {
				const [columns, ...rows] = await stmt.raw({ columnNames: true });
				reply = { ok: true, columns: columns || [], rows, changes: 0, last_row_id: 0 };
			} else {
				const r = await stmt.run();
				reply = { ok: true, columns: [], rows: [], changes: r.meta.changes || 0, last_row_id: r.meta.last_row_id || 0 };
			}
			stats.ms += Date.now() - t;
			stats.log.push('ok  ' + m.sql.slice(0, 160).replace(/\s+/g, ' '));
			return JSON.stringify(reply);
		} catch (e) {
			stats.ms += Date.now() - t;
			const error = String((e && e.message) || e);
			stats.failures.push({ sql: m.sql.slice(0, 400), error });
			stats.log.push('ERR ' + m.sql.slice(0, 160).replace(/\s+/g, ' ') + ' => ' + error.slice(0, 120));
			return JSON.stringify({ ok: false, error });
		}
	});

	const handler = new PHPRequestHandler({
		php,
		documentRoot: DOCROOT,
		absoluteUrl: origin,
		cookieStore: false,
		getFileNotFoundAction: () => ({ type: 'internal-redirect', uri: '/index.php' }),
	});
	return { php, handler, bootMs: { wasm: tWasm, site: tSite, files: tFiles, fileCount: count, fileBytes, opcacheFiles, memAt } };
}

let reserveTableReady = false;

// Source from R2, transforms by the Images binding, result to R2 (if dest).
async function imageJob(B, job) {
	const o = await B.get(job.src);
	if (!o) throw new Error('source not found: ' + job.src);
	let h = ENV.IMAGES.input(o.body);
	for (const t of job.ops || []) h = h.transform(t);
	const out = await h.output({ format: job.format, ...(job.quality ? { quality: job.quality } : {}) });
	const bytes = new Uint8Array(await out.response().arrayBuffer());
	if (job.dest) await B.put(job.dest, bytes, { httpMetadata: { contentType: job.format } });
	return bytes;
}
// Set by the Edge Cache mu-plugin when content changes. Read after the request.
let purgeRequested = false;
// Workers Cache purges always have Free-tier limits: 5 a minute, bursts of 25,
// per account. Purge at most once per PURGE_GAP_MS per isolate; the short TTL
// with stale-while-revalidate limits staleness when a purge is refused.
const PURGE_GAP_MS = 15000;
let lastPurge = 0;

// Page cache (Workers Cache). A response is cacheable only for a logged-out
// GET of a public page. Cookie is not in the Workers Cache key, so Vary: Cookie
// keeps a logged-in visitor from getting a logged-out page.
const WP_COOKIE = /(^|;\s*)(wordpress_logged_in_|wordpress_sec_|wp-postpass_|comment_author_|wp-settings-|woocommerce_|wp_woocommerce_session_)/;
function pageCacheHeaders(req, url, r, out, env) {
	const ttl = Number(env.PAGE_CACHE_TTL || 120);
	const wpCc = String([].concat(r.headers['cache-control'] || []).join(','));
	const cacheable =
		ttl > 0 &&
		(req.method === 'GET' || req.method === 'HEAD') &&
		[200, 301, 404].includes(r.httpStatusCode) &&
		!WP_COOKIE.test(req.headers.get('cookie') || '') &&
		!r.headers['set-cookie'] &&
		!/no-cache|no-store|private/i.test(wpCc) &&
		!/^\/(wp-admin|wp-login\.php|wp-cron\.php|_)/.test(url.pathname) &&
		!url.searchParams.has('preview') &&
		!url.searchParams.has('nocache');
	if (cacheable) {
		out.set('cache-control', `public, max-age=${ttl}, stale-while-revalidate=600`);
		out.set('cache-tag', 'wp-pages');
		out.append('vary', 'Cookie');
	} else if (!wpCc) {
		out.set('cache-control', 'private, no-store');
	}
}

// One R2 operation for the R2 Uploads mu-plugin (php/r2-uploads.php).
// Bodies cross the PHP to JS bridge as base64.
async function r2op(op) {
	const t0 = Date.now();
	try {
		return await r2opInner(op);
	} finally {
		// Wall time advances during I/O, so these numbers are real.
		const ms = Date.now() - t0;
		stats.r2[op.op] = stats.r2[op.op] || { n: 0, ms: 0 };
		stats.r2[op.op].n++;
		stats.r2[op.op].ms += ms;
	}
}

async function r2opInner(op) {
	try {
		const B = ENV.MEDIA;
		if (op.op === 'get') {
			const o = await B.get(op.key, op.length ? { range: { offset: op.offset || 0, length: op.length } } : undefined);
			if (!o) return { ok: true, found: false };
			const bytes = new Uint8Array(await o.arrayBuffer());
			return { ok: true, found: true, body: b64encode(bytes), size: o.size, mtime: Math.floor(o.uploaded.getTime() / 1000) };
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
			// Copy inside R2 (rename, staged uploads). The bytes never go to PHP.
			const o = await B.get(op.from);
			if (!o) return { ok: true, found: false };
			await B.put(op.to, o.body, { httpMetadata: { contentType: op.type || o.httpMetadata?.contentType || 'application/octet-stream' } });
			if (op.move) await B.delete(op.from);
			return { ok: true, found: true };
		}
		if (op.op === 'delete') {
			await B.delete(op.key);
			return { ok: true };
		}
		if (op.op === 'info') {
			const o = await B.get(op.key);
			if (!o) return { ok: true, found: false };
			const i = await ENV.IMAGES.info(o.body); // .info() is not billed
			return { ok: true, found: true, format: i.format, width: i.width, height: i.height, size: i.fileSize };
		}
		if (op.op === 'image') {
			const bytes = await imageJob(B, op);
			return { ok: true, size: bytes.length, ...(op.body ? { body: b64encode(bytes) } : {}) };
		}
		if (op.op === 'images') {
			// Several Images jobs in parallel (sub-sizes of one upload).
			const results = await Promise.allSettled((op.jobs || []).map((j) => imageJob(B, j)));
			const failed = results.filter((x) => x.status === 'rejected').map((x) => String(x.reason));
			return { ok: true, failed };
		}
		if (op.op === 'reserve') {
			// One atomic insert decides who gets a file name.
			if (!reserveTableReady) {
				await ENV.DB.prepare('CREATE TABLE IF NOT EXISTS _r2_reserved (key TEXT PRIMARY KEY, at INTEGER NOT NULL)').run();
				reserveTableReady = true;
			}
			if (await B.head(op.key)) return { ok: true, reserved: false };
			const r = await ENV.DB.prepare('INSERT OR IGNORE INTO _r2_reserved (key, at) VALUES (?, ?)').bind(op.key, Date.now()).run();
			return { ok: true, reserved: r.meta.changes === 1 };
		}
		if (op.op === 'list') {
			const l = await B.list({ prefix: op.prefix, delimiter: '/', limit: op.limit || 1000 });
			return { ok: true, keys: l.objects.map((o) => o.key), prefixes: l.delimitedPrefixes };
		}
		return { ok: false, error: 'unknown r2 op' };
	} catch (e) {
		return { ok: false, error: String((e && e.message) || e) };
	}
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

// GET and HEAD /wp-content/uploads/<path> come from R2, not PHP, with Range
// support (video seeking needs it). No PHP lock.
async function serveUpload(req, env, url) {
	let key;
	try {
		key = 'uploads/' + decodeURIComponent(url.pathname.slice('/wp-content/uploads/'.length));
	} catch {
		return new Response('bad path', { status: 400 });
	}
	// R2 keys are at most 1,024 bytes. A longer path cannot exist.
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
	// private: browsers keep it a day, the edge cache does not. A deleted upload
	// is then gone at once, with no purge. Purges are rate limited (5 a minute).
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

const INSTALL = `<?php
define( 'WP_INSTALLING', true );
require '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
if ( is_blog_installed() ) { echo json_encode( array( 'installed' => 'already' ) ); exit; }
$pw = trim( (string) @file_get_contents( '/tmp/admin-password' ) );
@unlink( '/tmp/admin-password' );
if ( strlen( $pw ) < 12 ) { echo json_encode( array( 'installed' => false, 'error' => 'admin password missing or shorter than 12' ) ); exit; }
$r = wp_install( 'WordPress on D1', 'admin', 'admin@example.com', false, '', $pw );
echo json_encode( array( 'installed' => true, 'user_id' => $r['user_id'] ) );
`;

export default {
	async fetch(req, env, ctx) {
		ENV = env;
		const url = new URL(req.url);
		if (url.pathname === '/_ping') return new Response('ok');
		// Spike endpoints need the SPIKE_TOKEN secret when it is set (always on a deploy).
		const spikeOk = !env.SPIKE_TOKEN || req.headers.get('x-spike-token') === env.SPIKE_TOKEN;
		if (url.pathname.startsWith('/_') && !spikeOk) return new Response('forbidden', { status: 403 });
		if (env.MEDIA && (req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/wp-content/uploads/')) return serveUpload(req, env, url);
		// XML-RPC lets one request try many passwords (system.multicall). Off unless XMLRPC=on.
		if (url.pathname === '/xmlrpc.php' && env.XMLRPC !== 'on') return new Response('XML-RPC is off', { status: 403 });
		const maxBody = env.MEDIA && isMediaUpload(req, url) ? Number(env.MAX_UPLOAD_BYTES || MAX_UPLOAD_BYTES) : Number(env.MAX_BODY_BYTES || MAX_BODY_BYTES);
		if (Number(req.headers.get('content-length') || 0) > maxBody) return new Response('request body too large', { status: 413 });
		return withPhp(() => handle(req, env, url, spikeOk, maxBody, ctx));
	},
};

async function handle(req, env, url, spikeOk, maxBody, ctx) {
	{
		if (url.pathname === '/_last') return Response.json(globalThis.__lastRequest || {});
		if (url.pathname === '/_peak') {
			bootPromise ??= boot(url.origin);
			const { php } = await bootPromise;
			const r = await php.run({ code: `<?php
				$a = memory_get_peak_usage(false); $b = memory_get_peak_usage(true);
				register_shutdown_function(function () use ($a, $b) { while (ob_get_level()) ob_end_clean(); echo 'PEAK' . json_encode(array('before' => array($a, $b), 'peak' => memory_get_peak_usage(false), 'peak_real' => memory_get_peak_usage(true), 'limit' => ini_get('memory_limit'), 'files' => count(get_included_files()))); });
				define('WP_USE_THEMES', true);
				ob_start(); require '/wordpress/wp-blog-header.php';` });
			return new Response(r.text.slice(r.text.indexOf('PEAK')));
		}
		if (url.pathname === '/_opcache-dump') {
			// Zip of the OPcache file cache, for opcache.sh. Run it after the e2e
			// requests, so it holds the scripts real pages use.
			if (!bootPromise) return new Response('not booted', { status: 409 });
			const { php } = await bootPromise;
			const files = {};
			const walk = (dir) => {
				for (const name of php.listFiles(dir)) {
					const p = dir + '/' + name;
					if (php.isDir(p)) walk(p);
					else if (!p.endsWith('/wordpress/wp-runtime.php.bin')) files[p.slice(OPCACHE_DIR.length + 1)] = php.readFileAsBuffer(p);
				}
			};
			walk(OPCACHE_DIR);
			const { zipSync } = await import('fflate');
			// Stored: the Worker uses each file as a view of the bundle, with no copy.
			return new Response(zipSync(files, { level: 0 }), { headers: { 'content-type': 'application/zip', 'x-files': String(Object.keys(files).length) } });
		}
		if (url.pathname === '/_mem') {
			if (!bootPromise) return Response.json({ booted: false });
			const { php, bootMs } = await bootPromise;
			const r = await php.run({ code: '<?php echo json_encode(array("opcache" => ini_get("opcache.enable"), "mc" => ini_get("opcache.memory_consumption"), "fco" => ini_get("opcache.file_cache_only"), "cached" => function_exists("opcache_get_status") && ($st = opcache_get_status(false)) ? $st["opcache_statistics"]["num_cached_scripts"] : null, "mem" => isset($st["memory_usage"]) ? $st["memory_usage"] : null));' });
			return Response.json({ bootMs, wasmMemoryBytes: php[__private__dont__use].HEAPU8.length, fileBytes: bootMs.fileBytes, fileCount: bootMs.fileCount, memAt: bootMs.memAt, ini: JSON.parse(r.text || '{}') });
		}
		try {
			const booted = !bootPromise;
			bootPromise ??= boot(url.origin);
			const { php, handler, bootMs } = await bootPromise;
			const start = { calls: stats.calls, ms: stats.ms, fail: stats.failures.length, log: stats.log.length };
			const delta = () => ({ calls: stats.calls - start.calls, ms: stats.ms - start.ms, failures: stats.failures.slice(start.fail), log: stats.log.slice(start.log) });
			const t0 = Date.now();
			if (url.pathname === '/_install') {
				php.writeFile('/tmp/admin-password', req.headers.get('x-admin-password') || (env.SPIKE_TOKEN ? '' : 'local-spike-password'));
				let out, errors;
				try {
					const r = await php.run({ code: INSTALL });
					out = r.text;
					errors = r.errors;
				} catch (e) {
					out = String((e && e.message) || e);
					errors = 'PHP exited non-zero';
				}
				// The runtime is not usable for requests after this script exits. Boot a fresh one next time.
				bootPromise = null;
				const tail = out.length > 6000 ? out.slice(-6000) : out;
				return Response.json({ bootMs, ms: Date.now() - t0, out: tail, errors: String(errors).slice(0, 4000), d1: delta() });
			}
			const headers = {};
			req.headers.forEach((v, k) => (headers[k] = v));
			let body;
			if (env.MEDIA && isMediaUpload(req, url) && Number(req.headers.get('content-length') || 0) > STAGE_MIN_BYTES) {
				const staged = await stageUpload(req, env);
				body = staged.body;
				headers['content-type'] = staged.contentType;
				headers['content-length'] = String(body.length);
			} else {
				body = ['GET', 'HEAD'].includes(req.method) ? undefined : new Uint8Array(await req.arrayBuffer());
			}
			if (body && body.length > maxBody) return new Response('request body too large', { status: 413 });
			purgeRequested = false;
			const r2before = JSON.stringify(stats.r2);
			const r2start = JSON.parse(r2before);
			const r = await handler.request({ url: url.pathname + url.search, method: req.method, headers, body });
			if (ctx && ctx.cache && purgeRequested) {
				// A purge already scheduled for later covers this change too.
				const wait = Math.max(0, lastPurge + PURGE_GAP_MS - Date.now());
				if (lastPurge <= Date.now()) {
					lastPurge = Date.now() + wait;
					ctx.waitUntil(
						new Promise((ok) => setTimeout(ok, wait))
							.then(() => ctx.cache.purge({ tags: ['wp-pages'] }))
							.catch((e) => console.log('cache purge failed', String(e))),
					);
				}
			}
			const out = new Headers();
			for (const [k, v] of Object.entries(r.headers)) for (const one of [].concat(v)) out.append(k, one);
			const d = delta();
			pageCacheHeaders(req, url, r, out, env);
			const r2now = JSON.stringify(stats.r2);
			if (r2now !== r2before) out.set('x-r2-ops', Object.entries(stats.r2).map(([k, v]) => `${k}:${v.n - (r2start[k]?.n || 0)}/${v.ms - (r2start[k]?.ms || 0)}ms`).filter((s) => !s.includes(':0/')).join(' '));
			out.set('x-d1-calls', String(d.calls));
			out.set('x-d1-ms', String(d.ms));
			out.set('x-d1-failures', String(d.failures.length));
			out.set('x-php-ms', String(Date.now() - t0));
			out.set('x-boot', booted ? '1' : '0');
			console.log(JSON.stringify({ m: 'req', path: url.pathname + url.search, boot: booted, d1: d.calls }));
			globalThis.__lastRequest = { url: url.pathname, status: r.httpStatusCode, ...d };
			const wasmBytes = php[__private__dont__use].HEAPU8.length;
			out.set('x-wasm-mib', String(Math.round(wasmBytes / 1048576)));
			// php-wasm answers a crashed runtime with a bare 500. Never reuse it.
			const crashed = r.httpStatusCode === 500 && r.text === 'Internal Server Error';
			if (crashed || wasmBytes > RECYCLE_WASM_BYTES) {
				bootPromise = null;
				out.set('x-runtime-recycled', crashed ? 'crashed' : 'memory');
			}
			return new Response(r.bytes, { status: r.httpStatusCode, headers: out });
		} catch (e) {
			bootPromise = null; // a failed runtime is not reused
			// The stack names internal paths. Only a spike-token holder sees it.
			return new Response(spikeOk ? String((e && e.stack) || e) : 'internal error', { status: 500 });
		}
	}
}
