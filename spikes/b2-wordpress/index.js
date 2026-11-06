// Spike B2: WordPress in a Worker, database on D1.
import wasmModule from './vendor/php_8_3.wasm';
import * as loader from './vendor/php_8_3.js';
import { loadPHPRuntime, PHP, PHPRequestHandler, setPhpIniEntries, __private__dont__use } from '@php-wasm/universal';
import { inflateSync } from 'fflate';
import { Container, ContainerProxy, getContainer } from '@cloudflare/containers';
import { DurableObject } from 'cloudflare:workers';
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
// Approach A (index-a.js) registers a MySQL handler here. B leaves it null and
// every database message goes to D1.
let dbHandler = null;
export function setDbHandler(h) {
	dbHandler = h;
}
// DB_IN_DO=on (issue #2, docs/approach-b.md 8j): the PHP object's own SQLite
// (ctx.storage.sql). The object sets it for each PHP run, under the PHP lock.
// In the Worker it is always null and every statement goes to D1.
let sqlDb = null;

// Object cache across requests (php/object-cache.php, docs/perf-dosql.md), in
// the PHP object with DB_IN_DO only: one object is the only writer, so
// WordPress's own deletes keep it exact. Least recently used goes first past
// OBJECT_CACHE_BYTES (values are base64 strings; their length is counted).
const OBJECT_CACHE_BYTES = 8 * 1024 * 1024;
const objectCache = new Map(); // key -> { v, exp, n }
let objectCacheBytes = 0;
function objectCacheClear() {
	objectCache.clear();
	objectCacheBytes = 0;
}
function objectCacheDrop(k) {
	const e = objectCache.get(k);
	if (!e) return false;
	objectCache.delete(k);
	objectCacheBytes -= e.n;
	return true;
}
function objectCacheOp(op) {
	stats.ocCalls++;
	const now = Date.now();
	if (op.op === 'get') {
		const v = op.k.map((k) => {
			const e = objectCache.get(k);
			if (!e) return null;
			if (e.exp && e.exp <= now) {
				objectCacheDrop(k);
				return null;
			}
			objectCache.delete(k); // most recently used goes last
			objectCache.set(k, e);
			stats.ocHits++;
			return e.v;
		});
		return { v };
	}
	if (op.op === 'set') {
		objectCacheDrop(op.k);
		const n = op.k.length + op.v.length;
		if (n > OBJECT_CACHE_BYTES / 4) return { ok: false };
		objectCache.set(op.k, { v: op.v, exp: op.ttl > 0 ? now + op.ttl * 1000 : 0, n });
		objectCacheBytes += n;
		for (const k of objectCache.keys()) {
			if (objectCacheBytes <= OBJECT_CACHE_BYTES) break;
			objectCacheDrop(k);
		}
		return { ok: true };
	}
	if (op.op === 'del') {
		let n = 0;
		for (const k of op.k) if (objectCacheDrop(k)) n++;
		return { n };
	}
	if (op.op === 'flush') {
		objectCacheClear();
		return { ok: true };
	}
	if (op.op === 'flush_group') {
		for (const k of [...objectCache.keys()]) if (k.startsWith(op.g)) objectCacheDrop(k);
		return { ok: true };
	}
	return { ok: false };
}
// Counters only grow. A request reports the difference, so a nested request
// (WordPress calling its own URL) cannot reset an outer one.
const stats = newStats();
let bootPromise;
// Performance instrument (docs/perf-dosql.md), PHP object only. Counts do not
// need the clock: in a Worker or a Durable Object, Date.now() moves only at
// I/O, so a time measured across synchronous PHP and SQLite work can read 0.
const ISOLATE_ID = Math.random().toString(36).slice(2, 8);
const isolateStart = Date.now();
let runtimeSerial = 0; // runtimes booted in this isolate
let runtimeServed = 0; // requests the current runtime served
let runtimeBootAt = 0;
let phpPending = 0; // object requests in the PHP queue or running
// The origin the current runtime booted with (WP_HOME in wp-runtime.php).
let bootOrigin = null;
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
	return { calls: 0, ms: 0, failures: [], log: [], r2: {}, rowsRead: 0, rowsWritten: 0, inflates: 0, inflateBytes: 0, ocCalls: 0, ocHits: 0 };
}

// The log and failure lists live as long as the isolate. Keep the newest only.
function trimStats() {
	if (stats.log.length > 2000) stats.log.splice(0, stats.log.length - 1000);
	if (stats.failures.length > 500) stats.failures.splice(0, stats.failures.length - 250);
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
// Lazy files whose contents are inflated now. evictLazy() drops them after a
// request: OPcache holds the compiled code, and a file can be inflated again.
// Measured 2026-11-04: with WooCommerce, keeping them hit "Worker exceeded
// memory limit".
// Within a request too: the inflated copies are capped at LAZY_CACHE_BYTES,
// oldest dropped first. A WooCommerce checkout reads about 1,500 compiled files.
const LAZY_CACHE_BYTES = 8 * 1024 * 1024;
const inflated = new Map(); // drop function -> bytes
let inflatedBytes = 0;
function evictLazy() {
	for (const drop of inflated.keys()) drop();
	inflated.clear();
	inflatedBytes = 0;
}
function noteInflated(drop, bytes) {
	stats.inflates++;
	stats.inflateBytes += bytes;
	inflated.set(drop, bytes);
	inflatedBytes += bytes;
	for (const [old, n] of inflated) {
		if (inflatedBytes <= LAZY_CACHE_BYTES || old === drop) break;
		old();
		inflated.delete(old);
		inflatedBytes -= n;
	}
}

function lazyFile(FS, path, entry) {
	FS.writeFile(path, new Uint8Array(0));
	const node = FS.lookupPath(path).node;
	let contents = null;
	let written = false;
	let used = entry.size;
	const drop = () => {
		if (!written) contents = null;
	};
	Object.defineProperty(node, 'contents', {
		configurable: true,
		get() {
			if (contents === null) {
				contents = entry.data();
				noteInflated(drop, contents.length);
			}
			return contents;
		},
		set(v) {
			contents = v;
			written = true; // PHP wrote this file. Keep it.
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

// One message from PHP: a D1 statement, an R2 or Images operation, a cache
// purge, or a failure report. In the Worker it comes through php.onMessage; in
// the checkout Container, through the outbound handler for worker.internal.
async function handleMessage(raw) {
	const m = JSON.parse(raw);
	if (m.oc) return JSON.stringify(objectCacheOp(m.oc));
	if (m.r2) return JSON.stringify(await r2op(m.r2));
	if (m.cache === 'purge') {
		purgeRequested = true;
		return '{}';
	}
	if (dbHandler && (m.mysql !== undefined || m.mysql_b64 !== undefined)) {
		const t = Date.now();
		stats.calls++;
		const reply = await dbHandler.query(ENV, m);
		stats.ms += Date.now() - t;
		const sql = String(m.mysql !== undefined ? m.mysql : '(binary SQL)');
		if (reply.ok) stats.log.push('ok  ' + sql.slice(0, 160).replace(/\s+/g, ' '));
		else {
			stats.failures.push({ sql: sql.slice(0, 400), error: reply.error });
			stats.log.push('ERR ' + sql.slice(0, 160).replace(/\s+/g, ' ') + ' => ' + String(reply.error).slice(0, 120));
		}
		return JSON.stringify(reply);
	}
	if (m.report) {
		stats.failures.push({ sql: m.sql.slice(0, 400), error: m.error });
		stats.log.push('ERR ' + m.sql.slice(0, 160).replace(/\s+/g, ' ') + ' => ' + m.error.slice(0, 120));
		return '{}';
	}
	if (sqlDb) return JSON.stringify(sqlStatement(sqlDb, m));
	const t = Date.now();
	stats.calls++;
	try {
		// A BLOB does not survive JSON. PHP sends a string that is not UTF-8 as
		// {"$b": base64}; bind it as bytes. D1 returns a BLOB as an array of
		// numbers or an ArrayBuffer; send it back to PHP as {"$b": base64}.
		// (Found 2026-11-05: Wordfence stores its settings in a BLOB column and
		// read them back as a PHP array, a fatal error on activation.)
		const params = (m.params || []).map((v) => (v && typeof v === 'object' && typeof v.$b === 'string' ? b64decode(v.$b).buffer : v));
		const stmt = ENV.DB.prepare(m.sql).bind(...params);
		const returnsRows = /^\s*(SELECT|PRAGMA|WITH|VALUES|EXPLAIN)\b/i.test(m.sql) || /\bRETURNING\b/i.test(m.sql);
		let reply;
		if (returnsRows) {
			const [columns, ...rows] = await stmt.raw({ columnNames: true });
			let blob = false;
			for (const row of rows)
				for (let i = 0; i < row.length; i++) {
					const v = row[i];
					if (v === null || typeof v !== 'object') continue;
					const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : Uint8Array.from(v);
					row[i] = { $b: b64encode(bytes) };
					blob = true;
				}
			reply = { ok: true, columns: columns || [], rows, changes: 0, last_row_id: 0, blob };
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
}

async function boot(origin) {
	bootOrigin = origin;
	runtimeSerial++;
	runtimeServed = 0;
	runtimeBootAt = Date.now();
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
	// - opcache.zip: the same, or a view of the bundled bytes if stored.
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
	// The object cache across requests (php/object-cache.php): only where one
	// object is the only writer. OBJECT_CACHE=off turns it off (to measure).
	if (ENV.PHP_IN_DO === 'on' && ENV.DB_IN_DO === 'on' && ENV.OBJECT_CACHE !== 'off') lines.push(`define('JS_OBJECT_CACHE', true);`);
	php.writeFile(DOCROOT + '/wp-runtime.php', lines.join('\n') + '\n');

	php.onMessage(handleMessage);

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
function schedulePurge(ctx) {
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
		if (op.op === 'reserve' && sqlDb) {
			sqlDb.exec('CREATE TABLE IF NOT EXISTS _r2_reserved (key TEXT PRIMARY KEY, at INTEGER NOT NULL)');
			if (await B.head(op.key)) return { ok: true, reserved: false };
			return { ok: true, reserved: sqlChanges(sqlDb, () => sqlDb.exec('INSERT OR IGNORE INTO _r2_reserved (key, at) VALUES (?, ?)', op.key, Date.now())) === 1 };
		}
		if (op.op === 'reserve') {
			// Approach A has no D1: r2-uploads.php falls back to core's unique names.
			if (!ENV.DB) return { ok: false, error: 'unknown r2 op reserve' };
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

// Checkout Container (issue #20). WooCommerce needs 256 MB of PHP memory; an
// isolate has 128 MB for everything, and checkout passed it on Paid. The store
// and the cart stay in the Worker. The first item in the cart starts this
// container, so it is warm by the time the shopper checks out. It sleeps when
// idle. Its PHP reaches D1, R2 and Images through worker.internal, below.
export { ContainerProxy };
export class WooCheckout extends Container {
	defaultPort = 80;
	sleepAfter = '5m';
	enableInternet = false;
	// The health check. The default ("ping") requested "/", so every check was a
	// full WordPress page render with D1 calls; the checks filled the PHP workers
	// and the container never passed its start check (measured 2026-11-04: 524).
	// /ping is a static file.
	pingEndpoint = 'localhost/ping';
	constructor(ctx, env) {
		super(ctx, env);
		this.envVars = {
			WP_SALT: env.WP_SALT || '',
			R2_UPLOADS: env.MEDIA ? '1' : '',
			CF_IMAGES: env.MEDIA && env.IMAGES ? '1' : '',
		};
	}
}
WooCheckout.outboundByHost = {
	'worker.internal': async (request, env) => {
		ENV = env;
		const raw = await request.text();
		if (env.CONTAINER_TRACE) console.log('c>', raw.slice(0, 140));
		const reply = await handleMessage(raw);
		return new Response(reply, { headers: { 'content-type': 'application/json' } });
	},
};

const CHECKOUT_ROUTE = /^\/wc\/store(\/v1)?\/checkout\/?$/;
const ADD_TO_CART_ROUTE = /^\/wc\/store(\/v1)?\/cart\/add-item\/?$/;
function restRoute(url) {
	return url.searchParams.get('rest_route') || (url.pathname.startsWith('/wp-json/') ? url.pathname.slice(8) : '');
}
function isCheckout(url) {
	return CHECKOUT_ROUTE.test(restRoute(url)) || /^\/checkout\/?$/.test(url.pathname) || url.searchParams.get('pagename') === 'checkout';
}
// The instance name. Change CHECKOUT_INSTANCE to start a new instance on the
// current image (a running instance keeps its image).
function checkoutContainer(env) {
	return getContainer(env.WOO_CHECKOUT, env.CHECKOUT_INSTANCE || 'checkout');
}

// Spike: time N sequential D1 statements from where this code runs.
async function d1ping(req, env, url, ctx) {
	const n = Math.min(50, Number(url.searchParams.get('n') || 20));
	const ms = [];
	// Approach A: the same 20 reads through Hyperdrive (the first one opens the connection).
	let connectMs = null;
	for (let i = 0; i < n; i++) {
		const t = Date.now();
		if (dbHandler) {
			const r = await dbHandler.query(env, { mysql: "SELECT option_value FROM wp_options WHERE option_name = 'siteurl'" });
			if (!r.ok) return Response.json({ error: r.error }, { status: 500 });
		} else await env.DB.prepare('SELECT option_value FROM wp_options WHERE option_name = ?').bind('siteurl').first();
		if (i === 0 && dbHandler) connectMs = Date.now() - t;
		else ms.push(Date.now() - t);
	}
	if (dbHandler) ctx.waitUntil(dbHandler.end());
	const n2 = ms.length;
	ms.sort((a, b) => a - b);
	return Response.json({ n: n2, first: connectMs, min: ms[0], median: ms[n2 >> 1], max: ms[n2 - 1], colo: req.cf && req.cf.colo });
}

// Spike: time N statements on the object's SQLite (db=object) or on D1 (db=d1),
// from inside the object. A Worker's clock does not move during CPU work, so on
// Cloudflare the object numbers may read 0: read CPU time in wrangler tail.
async function dbping(env, url, sql) {
	const db = url.searchParams.get('db') || (sql ? 'object' : 'd1');
	const n = Math.min(5000, Number(url.searchParams.get('n') || 20));
	const q = "SELECT option_value FROM wp_options WHERE option_name = 'siteurl'";
	const t0 = Date.now();
	if (db === 'object') {
		if (!sql) return new Response('DB_IN_DO is off', { status: 409 });
		for (let i = 0; i < n; i++) sql.exec(q).toArray();
	} else {
		if (!env.DB) return new Response('no DB binding', { status: 409 });
		for (let i = 0; i < n; i++) await env.DB.prepare(q).first();
	}
	const ms = Date.now() - t0;
	return Response.json({ db, n, totalMs: ms, perStatementMs: ms / n, databaseBytes: sql ? sql.databaseSize : null });
}

// PHP in a Durable Object (issue #28). The design is from HostlessWP
// (github.com/hostlesswp/hostlesswp, GPL-2.0-or-later, runtime/src/index.js,
// PhpRuntime and render()). On Workers Free a Worker request stops at about 2 s
// of CPU, less than a cold WordPress start. A Durable Object request may use
// 30 s. With PHP_IN_DO=on the Worker keeps static assets, R2 uploads and the
// page cache, and sends every request that needs PHP to this object. The object
// runs the same code as the Worker (handle, withPhp, handleMessage), with its
// own bindings (DB, MEDIA, IMAGES) from the same wrangler env.
// One statement on the object's SQLite, in the reply form of the D1 path
// (handleMessage). exec() is synchronous and returns a cursor. Differences from
// D1 handled here:
// - changes and last_row_id: D1 returns them in meta. Here they come from
//   changes() and last_insert_rowid(), read in the same synchronous turn.
//   total_changes() before and after tells if this statement changed rows, so
//   a statement that changes nothing reports 0, as D1 does.
// - A BLOB comes back as an ArrayBuffer; it goes to PHP as {"$b": base64}, and
//   {"$b"} parameters are bound as bytes, as on the D1 path.
// - Booleans are bound as 1 and 0.
// BEGIN, COMMIT and SAVEPOINT never reach here: d1-pdo.php answers them in PHP,
// as for D1 (sql.exec() refuses them).
function sqlChanges(db, run) {
	const before = db.exec('SELECT total_changes()').raw().next().value[0];
	run();
	const after = db.exec('SELECT total_changes()').raw().next().value[0];
	return after === before ? 0 : db.exec('SELECT changes()').raw().next().value[0];
}
function sqlParams(params) {
	return (params || []).map((v) => (v && typeof v === 'object' && typeof v.$b === 'string' ? b64decode(v.$b).buffer : typeof v === 'boolean' ? (v ? 1 : 0) : v));
}
function sqlRow(row) {
	let blob = false;
	for (let i = 0; i < row.length; i++) {
		const v = row[i];
		if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
			const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
			row[i] = { $b: b64encode(bytes) };
			blob = true;
		}
	}
	return blob;
}
function sqlStatement(db, m) {
	const t = Date.now();
	stats.calls++;
	try {
		const params = sqlParams(m.params);
		const returnsRows = /^\s*(SELECT|PRAGMA|WITH|VALUES|EXPLAIN)\b/i.test(m.sql) || /\bRETURNING\b/i.test(m.sql);
		let reply;
		if (returnsRows) {
			const cur = db.exec(m.sql, ...params);
			const rows = [...cur.raw()];
			// Billed units (Durable Objects pricing): rows read and written.
			stats.rowsRead += cur.rowsRead;
			stats.rowsWritten += cur.rowsWritten;
			let blob = false;
			for (const row of rows) blob = sqlRow(row) || blob;
			reply = { ok: true, columns: cur.columnNames || [], rows, changes: 0, last_row_id: 0, blob };
		} else {
			let changes = 0;
			changes = sqlChanges(db, () => {
				const cur = db.exec(m.sql, ...params);
				cur.toArray();
				stats.rowsRead += cur.rowsRead;
				stats.rowsWritten += cur.rowsWritten;
			});
			const insert = changes > 0 && /^\s*(INSERT|REPLACE)\b/i.test(m.sql);
			reply = { ok: true, columns: [], rows: [], changes, last_row_id: insert ? db.exec('SELECT last_insert_rowid()').raw().next().value[0] : 0 };
		}
		stats.ms += Date.now() - t;
		stats.log.push('ok  ' + m.sql.slice(0, 160).replace(/\s+/g, ' '));
		return reply;
	} catch (e) {
		stats.ms += Date.now() - t;
		const error = String((e && e.message) || e);
		stats.failures.push({ sql: m.sql.slice(0, 400), error });
		stats.log.push('ERR ' + m.sql.slice(0, 160).replace(/\s+/g, ' ') + ' => ' + error.slice(0, 120));
		return { ok: false, error };
	}
}

// Move a site in or out (DB_IN_DO). The dump is JSON lines: {"sql"} for each
// table, then {"sql","params"} for each row, then {"sql"} for each index,
// trigger and view, then {"end":true,"rows":N}. A dump without the end line is
// incomplete. Tables of SQLite and of Cloudflare (sqlite_*, _cf_*) are left out.
// Source: the object's SQLite, or ?from=d1 for the DB binding (moving a B site
// from D1). It runs under the PHP lock, so no PHP request writes meanwhile.
const DUMP_PAGE = 500;
function quoteId(name) {
	return '"' + String(name).replace(/"/g, '""') + '"';
}
function dumpSource(env, from) {
	if (from === 'd1') {
		if (!env.DB) throw new Error('no DB binding');
		return async (sql, params = []) => {
			const [columns, ...rows] = await env.DB.prepare(sql).bind(...params).raw({ columnNames: true });
			for (const row of rows)
				for (let i = 0; i < row.length; i++) {
					const v = row[i];
					if (v !== null && typeof v === 'object') row[i] = v instanceof ArrayBuffer ? v : ArrayBuffer.isView(v) ? v : Uint8Array.from(v).buffer;
				}
			return { columns: columns || [], rows };
		};
	}
	return async (sql, params = []) => {
		const cur = sqlDb.exec(sql, ...params);
		const rows = [...cur.raw()];
		return { columns: cur.columnNames, rows };
	};
}
async function dumpTo(writer, env, from) {
	const enc = new TextEncoder();
	const line = (o) => writer.write(enc.encode(JSON.stringify(o) + '\n'));
	try {
		const q = dumpSource(env, from);
		const master = await q("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND sql IS NOT NULL ORDER BY rowid");
		const tables = master.rows.filter((r) => r[0] === 'table');
		for (const [, , sql] of tables) await line({ sql });
		let total = 0;
		for (const [, name] of tables) {
			for (let off = 0; ; off += DUMP_PAGE) {
				const page = await q(`SELECT * FROM ${quoteId(name)} LIMIT ? OFFSET ?`, [DUMP_PAGE, off]);
				const insert = `INSERT INTO ${quoteId(name)} (${page.columns.map(quoteId).join(', ')}) VALUES (${page.columns.map(() => '?').join(', ')})`;
				for (const row of page.rows) {
					sqlRow(row);
					await line({ sql: insert, params: row });
				}
				total += page.rows.length;
				if (page.rows.length < DUMP_PAGE) break;
			}
		}
		for (const [, , sql] of master.rows.filter((r) => r[0] !== 'table')) await line({ sql });
		await line({ end: true, rows: total });
	} catch (e) {
		await line({ error: String((e && e.message) || e) }).catch(() => {});
	}
	await writer.close().catch(() => {});
}
// Import a dump, or part of one, into the object's SQLite: all lines of one
// request in one transaction. A failing line rolls the request back.
// The object must hold no tables, unless replace is set: then every table,
// index, trigger and view (not sqlite_* or _cf_*) is dropped first, in the same
// transaction. Any PHP request to an empty object makes the SQLite driver
// create its own _wp_sqlite_* tables, so "empty" rarely stays true.
const USER_OBJECTS = "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND sql IS NOT NULL";
function importInto(db, storage, text, replace) {
	let n = 0;
	let end = null;
	storage.transactionSync(() => {
		const existing = [...db.exec(USER_OBJECTS).raw()];
		if (existing.length && !replace) throw new Error(existing.length + ' tables or indexes exist; import with replace=1 to drop them first');
		if (replace) for (const [type, name] of existing) if (type === 'table' || type === 'view') db.exec(`DROP ${type.toUpperCase()} IF EXISTS ${quoteId(name)}`);
		for (const raw of text.split('\n')) {
			if (!raw.trim()) continue;
			const o = JSON.parse(raw);
			if (o.error) throw new Error('the dump has an error line: ' + o.error);
			if (o.end) {
				end = o;
				continue;
			}
			db.exec(o.sql, ...sqlParams(o.params)).toArray();
			n++;
		}
	});
	return { ok: true, statements: n, end };
}

// OPcache statistics of the runtime (php.run, not a WordPress request).
// opHits subtracts 1: this script's own compile counts as a hit or a miss.
async function opcacheStats(php) {
	try {
		const r = await php.run({ code: '<?php $s = function_exists("opcache_get_status") ? opcache_get_status(false) : false; echo json_encode($s ? array("hits" => $s["opcache_statistics"]["hits"], "misses" => $s["opcache_statistics"]["misses"], "cached" => $s["opcache_statistics"]["num_cached_scripts"], "full" => $s["cache_full"]) : null);' });
		return JSON.parse(r.text) || null;
	} catch {
		return null;
	}
}

const PURGE_HEADER = 'x-php-purge';
// When the Worker sent the request (Date.now()). The object's inbox wait is its
// own Date.now() at the start of fetch minus this. With the database in the
// object, PHP never yields to the event loop (no I/O), so a second request
// cannot start until the first ends: that wait is before fetch, where no
// counter in the object can see it. On Cloudflare the two clocks are on two
// machines (skew of a few ms).
const SENT_HEADER = 'x-perf-sent';
// The visitor's origin, from the Worker. On Cloudflare the object got the URL
// as http://<host>:443/..., so WP_HOME was wrong and every logged-out page
// answered 301 to that URL (measured 2026-11-05, wp-do-free). The Worker
// always sets this header (a visitor's value is replaced), and only the
// Worker can reach the object, so the object can trust it.
const ORIGIN_HEADER = 'x-wp-public-origin';
export class PhpRuntime extends DurableObject {
	async fetch(raw) {
		const env = this.env;
		ENV = env;
		const objectUrl = new URL(raw.url);
		const origin = raw.headers.get(ORIGIN_HEADER);
		// Without it, the object does not guess an origin: a wrong one redirects every page.
		if (!origin) return new Response('missing ' + ORIGIN_HEADER, { status: 500 });
		const url = new URL(objectUrl.pathname + objectUrl.search, origin);
		const inboxMs = raw.headers.get(SENT_HEADER) ? Date.now() - Number(raw.headers.get(SENT_HEADER)) : null;
		const req = new Request(raw);
		req.headers.delete(ORIGIN_HEADER);
		req.headers.delete(SENT_HEADER);
		if (dbHandler) dbHandler.reset();
		// The Worker checked the spike token already. Checked again: the object
		// trusts nothing it did not check itself.
		const spikeOk = !env.SPIKE_TOKEN || req.headers.get('x-spike-token') === env.SPIKE_TOKEN;
		if (url.pathname.startsWith('/_') && !spikeOk) return new Response('forbidden', { status: 403 });
		// Spike: the URL the object got, and the origin it uses.
		if (url.pathname === '/_origin') return Response.json({ objectUrl: raw.url, publicOrigin: origin, used: url.href });
		const maxBody = env.MEDIA && isMediaUpload(req, url) ? Number(env.MAX_UPLOAD_BYTES || MAX_UPLOAD_BYTES) : Number(env.MAX_BODY_BYTES || MAX_BODY_BYTES);
		const ctx = { inObject: true, waitUntil: (p) => this.ctx.waitUntil(p) };
		if (url.pathname === '/_d1ping') return d1ping(req, env, url, ctx);
		// DB_IN_DO=on: WordPress's database is this object's SQLite (8j).
		const sql = env.DB_IN_DO === 'on' ? this.ctx.storage.sql : null;
		if (url.pathname === '/_dbping') return dbping(env, url, sql);
		if (url.pathname === '/_dbexport' && req.method === 'GET') {
			const from = url.searchParams.get('from') === 'd1' ? 'd1' : 'object';
			if (from === 'object' && !sql) return new Response('DB_IN_DO is off', { status: 409 });
			const { readable, writable } = new TransformStream();
			this.ctx.waitUntil(withPhp(() => ((sqlDb = sql), dumpTo(writable.getWriter(), env, from))));
			return new Response(readable, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'private, no-store' } });
		}
		if (url.pathname === '/_dbimport' && req.method === 'POST') {
			if (!sql) return new Response('DB_IN_DO is off', { status: 409 });
			const text = await req.text();
			return withPhp(() => {
				objectCacheClear(); // the database changes outside WordPress's cache
				try {
					return Response.json({ ...importInto(sql, this.ctx.storage, text, url.searchParams.get('replace') === '1'), databaseBytes: sql.databaseSize });
				} catch (e) {
					return Response.json({ ok: false, error: String((e && e.message) || e) }, { status: 400 });
				}
			});
		}
		// Queue: requests ahead of this one in the PHP lock (a count), and the
		// wait for the lock (the clock moves at the I/O that ends each request).
		const tArrive = Date.now();
		const ahead = phpPending;
		phpPending++;
		return withPhp(async () => {
			const waitMs = Date.now() - tArrive;
			sqlDb = sql;
			try {
				const res = await handle(req, env, url, spikeOk, maxBody, ctx);
				try {
					// inMs: from the start of fetch to the response (object clock). The
					// Worker's object time minus inbox minus inMs is the wait to send the
					// response back, which the next request's PHP can block the same way.
					res.headers.set('x-perf-queue', JSON.stringify({ inboxMs, ahead, waitMs, inMs: Date.now() - tArrive }));
				} catch {}
				return res;
			} finally {
				phpPending--;
			}
		});
	}
}

// Which object serves a request. PHP_DO_POOL objects (default 1) share the
// load; each boots its own PHP. Spike endpoints (/_install, /_opcache-dump,
// /_last, /_mem) always go to php-0, so they see the runtime the tests used.
function phpObjectName(env, url) {
	// DB_IN_DO: the object IS the database, so there is one object.
	const pool = env.DB_IN_DO === 'on' ? 1 : Math.max(1, Math.floor(Number(env.PHP_DO_POOL || 1)));
	if (pool === 1 || url.pathname.startsWith('/_')) return 'php-0';
	return 'php-' + Math.floor(Math.random() * pool);
}

// Seconds a client waits after an overload 503. One object serves about 5
// uncached pages a second (docs/perf-dosql.md), so a full queue drains in
// seconds, not minutes.
const OVERLOAD_RETRY_AFTER_S = '5';

async function toPhpObject(req, env, url, ctx) {
	const name = phpObjectName(env, url);
	// The hint applies only when the object is made. D1's primary is in the
	// Chicago area; "enam" is Eastern North America.
	const stub = env.PHP_RUNTIME.get(env.PHP_RUNTIME.idFromName(name), env.PHP_LOCATION ? { locationHint: env.PHP_LOCATION } : undefined);
	const fwd = new Request(req);
	fwd.headers.set(ORIGIN_HEADER, url.origin);
	const t0 = Date.now();
	fwd.headers.set(SENT_HEADER, String(t0));
	let r;
	try {
		r = await stub.fetch(fwd);
	} catch (e) {
		// The object runs one PHP request at a time. Past its queue limit the
		// runtime refuses with "Durable Object is overloaded" (measured
		// 2026-11-05: 27 of 400 at 100 clients, docs/perf-dosql.md). Uncaught,
		// that was an exception and a bare 503 with no body. Answer it: a 503
		// the client can act on, never stored by the page cache in front of the
		// Worker (a cached error would reach readers after the queue drains).
		// Other errors are thrown as before.
		if (!(e && (e.overloaded === true || /Durable Object is overloaded/.test(String(e.message))))) throw e;
		console.log(JSON.stringify({ m: 'overloaded', path: url.pathname, error: String(e.message).slice(0, 200) }));
		return new Response('The site is busy. Please try again in a few seconds.\n', {
			status: 503,
			headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'retry-after': OVERLOAD_RETRY_AFTER_S, 'x-php-object': name, 'x-overloaded': '1' },
		});
	}
	const out = new Response(r.body, r);
	if (out.headers.has(PURGE_HEADER)) {
		out.headers.delete(PURGE_HEADER);
		if (ctx.cache) schedulePurge(ctx);
		// So a test can see that the purge request crossed from the object.
		out.headers.set('x-cache-purge', ctx.cache ? 'scheduled' : 'no-cache-api');
	}
	out.headers.set('x-php-object', name);
	// Wall time from the Worker to the object and back, PHP time included.
	const objectMs = Date.now() - t0;
	out.headers.set('x-object-ms', String(objectMs));
	// Server-Timing (docs/perf-dosql.md): object = the Worker's own wall time
	// for the object (its clock moves at this I/O); the rest is from the object.
	try {
		const p = JSON.parse(out.headers.get('x-perf') || '{}');
		const q = JSON.parse(out.headers.get('x-perf-queue') || '{}');
		const t = [`object;dur=${objectMs}`];
		if (q.inboxMs !== undefined && q.inboxMs !== null) t.push(`inbox;dur=${q.inboxMs}`);
		if (q.waitMs !== undefined) t.push(`queue;dur=${q.waitMs};desc="ahead ${q.ahead}"`);
		if (q.inMs !== undefined && q.inboxMs !== undefined && q.inboxMs !== null) t.push(`in;dur=${q.inMs}`, `outbox;dur=${objectMs - q.inboxMs - q.inMs}`);
		if (p.bootWaitMs !== undefined) t.push(`boot;dur=${p.bootWaitMs};desc="boot ${p.boot}"`);
		if (p.phpMs !== undefined) t.push(`php;dur=${p.phpMs}`, `db;dur=${p.dbMs};desc="${p.dbN} statements"`);
		out.headers.set('server-timing', t.join(', '));
		out.headers.set('x-perf-worker', JSON.stringify({ colo: (req.cf && req.cf.colo) || null, iso: ISOLATE_ID }));
	} catch {}
	return out;
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
		// Approach A: a Worker request cannot use a connection another request opened.
		// Drop any left over (an /_install run, or a request that failed early).
		if (dbHandler) dbHandler.reset();
		// Spike endpoints need the SPIKE_TOKEN secret when it is set (always on a deploy).
		const spikeOk = !env.SPIKE_TOKEN || req.headers.get('x-spike-token') === env.SPIKE_TOKEN;
		if (url.pathname.startsWith('/_') && !spikeOk) return new Response('forbidden', { status: 403 });
		if (env.MEDIA && (req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/wp-content/uploads/')) return serveUpload(req, env, url);
		// XML-RPC lets one request try many passwords (system.multicall). Off unless XMLRPC=on.
		if (url.pathname === '/xmlrpc.php' && env.XMLRPC !== 'on') return new Response('XML-RPC is off', { status: 403 });
		const maxBody = env.MEDIA && isMediaUpload(req, url) ? Number(env.MAX_UPLOAD_BYTES || MAX_UPLOAD_BYTES) : Number(env.MAX_BODY_BYTES || MAX_BODY_BYTES);
		if (Number(req.headers.get('content-length') || 0) > maxBody) return new Response('request body too large', { status: 413 });
		// PHP in a Durable Object (PHP_IN_DO=on, issue #28): every request that
		// needs PHP goes to the object, including /_d1ping (D1 as PHP sees it).
		// DB_IN_DO needs the object; without it the Worker would use D1 silently.
		if (env.DB_IN_DO === 'on' && env.PHP_IN_DO !== 'on') return new Response('DB_IN_DO=on needs PHP_IN_DO=on', { status: 500 });
		// Without the binding, fail: a silent fallback would run PHP in the Worker.
		if (env.PHP_IN_DO === 'on') {
			// WordPress serves no WebSockets. PHP's socket layer opens them to the
			// site itself (during /_install, measured 2026-11-05), and such a
			// request must never reach PHP: it booted a runtime with a wrong origin.
			if (req.headers.get('upgrade')) return new Response('WebSocket is not served', { status: 426 });
			return env.PHP_RUNTIME ? toPhpObject(req, env, url, ctx) : new Response('PHP_IN_DO=on needs the PHP_RUNTIME Durable Object binding', { status: 500 });
		}
		// Spike: time N sequential D1 statements from where this Worker runs.
		if (url.pathname === '/_d1ping') return d1ping(req, env, url, ctx);
		// Spike: stop the checkout Container, so the next request starts the current image.
		if (env.WOO_CHECKOUT && url.pathname === '/_container-stop') {
			const name = url.searchParams.get('name');
			await (name ? getContainer(env.WOO_CHECKOUT, name) : checkoutContainer(env)).stop();
			return new Response('stopped ' + (name || 'current'));
		}
		// Spike: reach the checkout Container on any path, e.g. /_container/_diag.php
		if (env.WOO_CHECKOUT && url.pathname.startsWith('/_container/')) {
			const inner = new URL(url.pathname.slice('/_container'.length) + url.search, url.origin);
			const r = await checkoutContainer(env).fetch(new Request(inner, req));
			const out = new Response(r.body, r);
			out.headers.set('cache-control', 'private, no-store');
			return out;
		}
		if (env.WOO_CHECKOUT && env.CHECKOUT_CONTAINER === 'on' && isCheckout(url)) {
			const r = await checkoutContainer(env).fetch(req);
			const out = new Response(r.body, r);
			out.headers.set('x-served-by', 'checkout-container');
			// Checkout is per shopper: never let the edge cache keep it.
			if (!out.headers.has('cache-control')) out.headers.set('cache-control', 'private, no-store');
			return out;
		}
		return withPhp(() => handle(req, env, url, spikeOk, maxBody, ctx));
	},
};

async function handle(req, env, url, spikeOk, maxBody, ctx) {
	{
		// In the PHP object, a runtime serves only the origin it booted with (8i).
		// The first request after /_install used to boot the runtime for every
		// later one, and that request could be PHP's own socket connection back
		// to the site, with the URL http://<host>:443/: every page then answered
		// 301 to that URL. A request for another origin now boots a new runtime.
		if (ctx && ctx.inObject && bootPromise && bootOrigin !== url.origin) bootPromise = null;
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
		if (url.pathname === '/_activate') {
			// Activate a plugin, e.g. ?plugin=woocommerce/woocommerce.php. Spike only.
			bootPromise ??= boot(url.origin);
			const { php } = await bootPromise;
			const plugin = url.searchParams.get('plugin') || '';
			if (!/^[a-z0-9-]+\/[a-z0-9-]+\.php$/.test(plugin)) return new Response('bad plugin', { status: 400 });
			const start = stats.calls;
			let r;
			try {
				r = await php.run({ code: `<?php
					define( 'WP_ADMIN', true );
					require '/wordpress/wp-load.php';
					require_once ABSPATH . 'wp-admin/includes/plugin.php';
					wp_set_current_user( 1 );
					$r = activate_plugin( '${plugin}' );
					// WooCommerce sends the first admin visit to its setup wizard (a 302 on /wp-admin/). A deploy has no use for it.
					delete_transient( '_wc_activation_redirect' );
					// WooCommerce makes its order tables (HPOS) on the first admin page view. dbDelta
					// first runs DESCRIBE on each missing table, which is an error by design. Make them
					// here, so that one-time step is part of the activation and not of a visitor's page.
					if ( function_exists( 'wc_get_container' ) && class_exists( 'Automattic\\\\WooCommerce\\\\Internal\\\\DataStores\\\\Orders\\\\DataSynchronizer' ) ) {
						$sync = wc_get_container()->get( 'Automattic\\\\WooCommerce\\\\Internal\\\\DataStores\\\\Orders\\\\DataSynchronizer' );
						if ( ! $sync->check_orders_table_exists() ) $sync->create_database_tables();
					}
					echo json_encode( array( 'active' => is_plugin_active( '${plugin}' ), 'error' => is_wp_error( $r ) ? $r->get_error_message() : null ) );` });
			} catch (e) {
				bootPromise = null;
				return new Response('activate failed: ' + String((e && e.message) || e), { status: 500 });
			}
			bootPromise = null; // a fresh runtime loads the plugin cleanly
			return new Response(JSON.stringify({ out: r.text.slice(-2000), errors: String(r.errors).slice(0, 2000), d1: stats.calls - start }), { headers: { 'content-type': 'application/json' } });
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
			// Deflated: with WooCommerce, a stored zip passes the 64 MiB Worker size
			// limit. The Worker inflates each file on its first read only.
			return new Response(zipSync(files, { level: 6 }), { headers: { 'content-type': 'application/zip', 'x-files': String(Object.keys(files).length) } });
		}
		if (url.pathname === '/_mem') {
			if (!bootPromise) return Response.json({ booted: false });
			const { php, bootMs } = await bootPromise;
			const r = await php.run({ code: '<?php echo json_encode(array("opcache" => ini_get("opcache.enable"), "mc" => ini_get("opcache.memory_consumption"), "fco" => ini_get("opcache.file_cache_only"), "cached" => function_exists("opcache_get_status") && ($st = opcache_get_status(false)) ? $st["opcache_statistics"]["num_cached_scripts"] : null, "mem" => isset($st["memory_usage"]) ? $st["memory_usage"] : null));' });
			return Response.json({ bootMs, wasmMemoryBytes: php[__private__dont__use].HEAPU8.length, fileBytes: bootMs.fileBytes, fileCount: bootMs.fileCount, memAt: bootMs.memAt, ini: JSON.parse(r.text || '{}') });
		}
		try {
			const tBoot = Date.now();
			const booted = !bootPromise;
			bootPromise ??= boot(url.origin);
			const { php, handler, bootMs } = await bootPromise;
			const bootWaitMs = Date.now() - tBoot;
			const wasm0 = php[__private__dont__use].HEAPU8.length;
			const start = { calls: stats.calls, ms: stats.ms, fail: stats.failures.length, log: stats.log.length, rowsRead: stats.rowsRead, rowsWritten: stats.rowsWritten, inflates: stats.inflates, inflateBytes: stats.inflateBytes, ocCalls: stats.ocCalls, ocHits: stats.ocHits };
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
				objectCacheClear(); // the database changed outside WordPress's cache
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
			// OPcache counters before and after, only when a spike-token holder asks (two extra php.run calls).
			const wantOpcache = ctx && ctx.inObject && spikeOk && req.headers.get('x-perf-opcache') === '1';
			const op0 = wantOpcache ? await opcacheStats(php) : null;
			const tPhp = Date.now();
			const r = await handler.request({ url: url.pathname + url.search, method: req.method, headers, body });
			const phpOnlyMs = Date.now() - tPhp;
			const op1 = wantOpcache ? await opcacheStats(php) : null;
			// Approach A: close this request's MySQL connection after the response.
			if (dbHandler) (ctx ? ctx.waitUntil(dbHandler.end()) : dbHandler.end());
			if (ctx && ctx.cache && purgeRequested) schedulePurge(ctx);
			const out = new Headers();
			// In the PHP object there is no ctx.cache: the Worker purges (PURGE_HEADER).
			if (ctx && ctx.inObject && purgeRequested) out.set(PURGE_HEADER, '1');
			for (const [k, v] of Object.entries(r.headers)) for (const one of [].concat(v)) out.append(k, one);
			const d = delta();
			pageCacheHeaders(req, url, r, out, env);
			// A filled cart means a checkout may follow: start the container now.
			if (env.WOO_CHECKOUT && env.CHECKOUT_CONTAINER === 'on' && r.httpStatusCode === 201 && ADD_TO_CART_ROUTE.test(restRoute(url))) {
				ctx.waitUntil(checkoutContainer(env).startAndWaitForPorts().catch((e) => console.log('checkout warm-up failed', String(e))));
				out.set('x-checkout-warmup', '1');
			}
			trimStats();
			const r2now = JSON.stringify(stats.r2);
			if (r2now !== r2before) out.set('x-r2-ops', Object.entries(stats.r2).map(([k, v]) => `${k}:${v.n - (r2start[k]?.n || 0)}/${v.ms - (r2start[k]?.ms || 0)}ms`).filter((s) => !s.includes(':0/')).join(' '));
			if (sqlDb) {
				out.set('x-db', 'object-sqlite');
				out.set('x-db-rows', `read=${stats.rowsRead - start.rowsRead} written=${stats.rowsWritten - start.rowsWritten}`);
			}
			out.set('x-d1-calls', String(d.calls));
			out.set('x-d1-ms', String(d.ms));
			out.set('x-d1-failures', String(d.failures.length));
			if (d.failures.length && spikeOk && env.SPIKE_TOKEN) out.set('x-d1-first-failure', (d.failures[0].error + ' | ' + d.failures[0].sql).replace(/[^\x20-\x7e]/g, ' ').slice(0, 600));
			out.set('x-php-ms', String(Date.now() - t0));
			out.set('x-boot', booted ? '1' : '0');
			if (ctx && ctx.inObject) out.set('x-boot-origin', bootOrigin);
			console.log(JSON.stringify({ m: 'req', path: url.pathname + url.search, boot: booted, d1: d.calls }));
			globalThis.__lastRequest = { url: url.pathname, status: r.httpStatusCode, ...d };
			evictLazy();
			const wasmBytes = php[__private__dont__use].HEAPU8.length;
			out.set('x-wasm-mib', String(Math.round(wasmBytes / 1048576)));
			// php-wasm answers a crashed runtime with a bare 500. Never reuse it.
			const crashed = r.httpStatusCode === 500 && r.text === 'Internal Server Error';
			if (crashed || wasmBytes > RECYCLE_WASM_BYTES) {
				bootPromise = null;
				out.set('x-runtime-recycled', crashed ? 'crashed' : 'memory');
			}
			if (ctx && ctx.inObject) {
				runtimeServed++;
				const now = Date.now();
				const perf = {
					iso: ISOLATE_ID,
					isoAgeS: Math.round((now - isolateStart) / 1000),
					rt: runtimeSerial,
					rtServed: runtimeServed,
					rtAgeS: Math.round((now - runtimeBootAt) / 1000),
					boot: booted ? 1 : 0,
					bootWaitMs,
					phpMs: phpOnlyMs,
					dbN: d.calls,
					dbMs: d.ms,
					inflates: stats.inflates - start.inflates,
					inflateKiB: Math.round((stats.inflateBytes - start.inflateBytes) / 1024),
					wasm0MiB: Math.round(wasm0 / 1048576),
					wasm1MiB: Math.round(wasmBytes / 1048576),
					bytes: r.bytes.length,
					ocCalls: stats.ocCalls - start.ocCalls,
					ocHits: stats.ocHits - start.ocHits,
					ocKeys: objectCache.size,
					ocKiB: Math.round(objectCacheBytes / 1024),
					...(op0 && op1 ? { opHits: op1.hits - op0.hits - 1, opMisses: op1.misses - op0.misses, opCached: op1.cached, opFull: op1.full } : {}),
				};
				out.set('x-perf', JSON.stringify(perf));
				console.log(JSON.stringify({ m: 'perf', id: req.headers.get('x-perf-id'), path: url.pathname, ...perf }));
			}
			return new Response(r.bytes, { status: r.httpStatusCode, headers: out });
		} catch (e) {
			bootPromise = null; // a failed runtime is not reused
			// The stack names internal paths. Only a spike-token holder sees it.
			return new Response(spikeOk ? String((e && e.stack) || e) : 'internal error', { status: 500 });
		}
	}
}
