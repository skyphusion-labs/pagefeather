// Spike B2: WordPress in a Worker, database on D1.
import wasmModule from './node_modules/@php-wasm/web-8-3/jspi/8_3_36/php_8_3.wasm';
import * as loader from './vendor/php_8_3.js';
import { loadPHPRuntime, PHP, PHPRequestHandler } from '@php-wasm/universal';
import { unzipSync } from 'fflate';
import siteZip from './build/site.zip';

const DOCROOT = '/wordpress';
let ENV;
// Counters only grow. A request reports the difference, so a nested request
// (WordPress calling its own URL) cannot reset an outer one.
const stats = newStats();
let bootPromise;

function newStats() {
	return { calls: 0, ms: 0, failures: [], log: [] };
}

async function boot(origin) {
	const t0 = Date.now();
	const id = await loadPHPRuntime(loader, {
		instantiateWasm(imports, done) {
			const inst = new WebAssembly.Instance(wasmModule, imports);
			done(inst, wasmModule);
			return inst.exports;
		},
	});
	const php = new PHP(id);
	const tWasm = Date.now() - t0;

	const files = unzipSync(new Uint8Array(siteZip));
	let count = 0;
	for (const [path, data] of Object.entries(files)) {
		const full = '/' + path;
		if (path.endsWith('/')) {
			php.mkdir(full);
			continue;
		}
		php.mkdir(full.slice(0, full.lastIndexOf('/')));
		php.writeFile(full, data);
		count++;
	}
	const tFiles = Date.now() - t0 - tWasm;

	php.onMessage(async (raw) => {
		const m = JSON.parse(raw);
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
	return { php, handler, bootMs: { wasm: tWasm, files: tFiles, fileCount: count } };
}

const INSTALL = `<?php
define( 'WP_INSTALLING', true );
require '/wordpress/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
if ( is_blog_installed() ) { echo json_encode( array( 'installed' => 'already' ) ); exit; }
$r = wp_install( 'WordPress on D1', 'admin', 'admin@example.com', true, '', 'local-spike-password' );
echo json_encode( array( 'installed' => true, 'user_id' => $r['user_id'] ) );
`;

export default {
	async fetch(req, env) {
		ENV = env;
		const url = new URL(req.url);
		if (url.pathname === '/_ping') return new Response('ok');
		if (url.pathname === '/_last') return Response.json(globalThis.__lastRequest || {});
		try {
			bootPromise ??= boot(url.origin);
			const { php, handler, bootMs } = await bootPromise;
			const start = { calls: stats.calls, ms: stats.ms, fail: stats.failures.length, log: stats.log.length };
			const delta = () => ({ calls: stats.calls - start.calls, ms: stats.ms - start.ms, failures: stats.failures.slice(start.fail), log: stats.log.slice(start.log) });
			const t0 = Date.now();
			if (url.pathname === '/_install') {
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
			const body = ['GET', 'HEAD'].includes(req.method) ? undefined : new Uint8Array(await req.arrayBuffer());
			const headers = {};
			req.headers.forEach((v, k) => (headers[k] = v));
			const r = await handler.request({ url: url.pathname + url.search, method: req.method, headers, body });
			const out = new Headers();
			for (const [k, v] of Object.entries(r.headers)) for (const one of [].concat(v)) out.append(k, one);
			const d = delta();
			out.set('x-d1-calls', String(d.calls));
			out.set('x-d1-ms', String(d.ms));
			out.set('x-d1-failures', String(d.failures.length));
			out.set('x-php-ms', String(Date.now() - t0));
			globalThis.__lastRequest = { url: url.pathname, status: r.httpStatusCode, ...d };
			return new Response(r.bytes, { status: r.httpStatusCode, headers: out });
		} catch (e) {
			return new Response(String((e && e.stack) || e), { status: 500 });
		}
	},
};
