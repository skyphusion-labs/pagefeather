// Test user Worker for the Workers for Platforms spike (issue #35). It is
// uploaded twice into the dispatch namespace (tenant-a, tenant-b) and answers
// one JSON object per check, so tests/wfp/check.py can record evidence.
//
//   /ping            no bindings
//   /do              SQLite-backed Durable Object: a counter in ctx.storage.sql
//   /d1              D1: SELECT through the binding (D1 refuses sqlite_version())
//   /r2              R2: put, get, delete one object
//   /images          Images: info() of a 1x1 PNG
//   /burn?ms=N       busy CPU for N ms (custom limit cpuMs)
//   /sub?n=N         N fetch() calls to https://example.com/ (custom limit subRequests, outbound Worker)
//   /do-sub          one fetch() from inside the Durable Object (outbound Worker)
import { DurableObject } from 'cloudflare:workers';

export class Counter extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS c (id INTEGER PRIMARY KEY, n INTEGER)');
	}
	async bump() {
		const sql = this.ctx.storage.sql;
		sql.exec('INSERT INTO c (id, n) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1');
		const n = sql.exec('SELECT n FROM c WHERE id = 1').one().n;
		return { n, databaseSize: sql.databaseSize, tenant: this.env.TENANT || null };
	}
	async sub() {
		return fetchMarked('https://example.com/');
	}
}

// 1x1 transparent PNG.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0));

async function fetchMarked(url) {
	try {
		const r = await fetch(url);
		await r.arrayBuffer();
		return { status: r.status, outbound: r.headers.get('x-wfp-outbound') };
	} catch (e) {
		return { error: String((e && e.message) || e) };
	}
}

async function check(name, fn) {
	const t0 = Date.now();
	try {
		return { check: name, ok: true, ms: Date.now() - t0, ...(await fn()) };
	} catch (e) {
		return { check: name, ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) };
	}
}

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		const p = url.pathname;
		let out;
		if (p === '/ping') out = { check: 'ping', ok: true, tenant: env.TENANT || null };
		else if (p === '/do')
			out = await check('do-sqlite', async () => env.COUNTER.get(env.COUNTER.idFromName('one')).bump());
		else if (p === '/d1')
			out = await check('d1', async () => ({ row: await env.DB.prepare('SELECT 1 AS one').first() }));
		else if (p === '/r2')
			out = await check('r2', async () => {
				const key = 'spike/' + (env.TENANT || 'x') + '/' + crypto.randomUUID();
				await env.BUCKET.put(key, 'hello');
				const got = await (await env.BUCKET.get(key)).text();
				await env.BUCKET.delete(key);
				return { roundtrip: got === 'hello' };
			});
		else if (p === '/images')
			out = await check('images', async () => {
				const i = await env.IMAGES.info(new Blob([PNG]).stream());
				return { format: i.format, width: i.width, height: i.height };
			});
		else if (p === '/burn')
			out = await check('burn', async () => {
				// Date.now() does not advance during pure CPU work in Workers, so
				// the loop runs a fixed number of steps per asked ms.
				const ms = Number(url.searchParams.get('ms') || 50);
				let x = 0;
				for (let i = 0; i < ms * 100000; i++) x += Math.sqrt(i);
				return { ms_asked: ms, x: x > 0 };
			});
		else if (p === '/sub')
			out = await check('sub', async () => {
				const n = Number(url.searchParams.get('n') || 1);
				const r = [];
				for (let i = 0; i < n; i++) r.push(await fetchMarked('https://example.com/?i=' + i));
				return { n, results: r };
			});
		else if (p === '/do-sub')
			out = await check('do-sub', async () => env.COUNTER.get(env.COUNTER.idFromName('one')).sub());
		else return new Response('not found', { status: 404 });
		return Response.json(out, { status: out.ok === false ? 500 : 200 });
	},
};
