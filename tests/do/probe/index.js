// Placement probe for PHP in a Durable Object (issue #28).
// GET /?hint=enam&db=enam[&n=2][&session=1] makes (or reuses) the object
// "<hint>-<n>" with that location hint and runs, from inside it, 20 reads and
// 5 writes on the D1 database bound as DB_<db>. It answers where the object
// runs (colo from /cdn-cgi/trace) and the median ms per statement.
// GET /worker?db=enam runs the same from the Worker itself, for comparison.
import { DurableObject } from 'cloudflare:workers';

async function colo() {
	const t = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text();
	return (t.match(/^colo=(\w+)/m) || [])[1] || null;
}

async function measure(env, dbName, session) {
	const base = env['DB_' + dbName];
	if (!base) return { error: 'no binding DB_' + dbName };
	await base.prepare('CREATE TABLE IF NOT EXISTS t (k INTEGER PRIMARY KEY, v TEXT)').run();
	await base.prepare("INSERT OR IGNORE INTO t (k, v) VALUES (1, 'x')").run();
	const db = session ? base.withSession('first-unconstrained') : base;
	const reads = [];
	const writes = [];
	for (let i = 0; i < 20; i++) {
		const t = Date.now();
		await db.prepare('SELECT v FROM t WHERE k = ?').bind(1).first();
		reads.push(Date.now() - t);
	}
	for (let i = 0; i < 5; i++) {
		const t = Date.now();
		await db.prepare('UPDATE t SET v = ? WHERE k = 1').bind(String(Date.now())).run();
		writes.push(Date.now() - t);
	}
	const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
	return { readMedian: med(reads), readMin: Math.min(...reads), writeMedian: med(writes) };
}

export class Probe extends DurableObject {
	async fetch(req) {
		const u = new URL(req.url);
		return Response.json({ where: 'object', colo: await colo(), ...(await measure(this.env, u.searchParams.get('db'), u.searchParams.get('session') === '1')) });
	}
}

export default {
	async fetch(req, env) {
		const u = new URL(req.url);
		if (u.pathname === '/worker') return Response.json({ where: 'worker', colo: await colo(), ...(await measure(env, u.searchParams.get('db'), u.searchParams.get('session') === '1')) });
		const hint = u.searchParams.get('hint') || 'enam';
		const name = hint + '-' + (u.searchParams.get('n') || '1');
		const stub = env.PROBE.get(env.PROBE.idFromName(name), hint === 'none' ? undefined : { locationHint: hint });
		return stub.fetch(req);
	},
};
