// Dispatch Worker for the Workers for Platforms spike (issue #35), on
// workers.dev only. /<script>/<path> runs <path> on user Worker <script> in the
// namespace. Query options (the user Worker sees the same query string):
//   cpuMs=N, subRequests=N   custom limits for this call
//   outbound=1               use the binding with the outbound Worker
// A dispatch error answers 502 with JSON, so check.py records what failed.
//
// Site mode: with the var SITE_SCRIPT set, every path goes to that one script,
// unchanged. This is the platform's real shape (one hostname, one customer
// script) on a workers.dev name, for a WordPress site whose links start at /.
export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		const m = env.SITE_SCRIPT ? [null, env.SITE_SCRIPT, url.pathname] : url.pathname.match(/^\/([a-z0-9-]{1,63})(\/.*)?$/);
		if (!m) return new Response('usage: /<script>/<path>', { status: 400 });
		const script = m[1];
		const limits = {};
		if (url.searchParams.has('cpuMs')) limits.cpuMs = Number(url.searchParams.get('cpuMs'));
		if (url.searchParams.has('subRequests')) limits.subRequests = Number(url.searchParams.get('subRequests'));
		const viaOutbound = url.searchParams.get('outbound') === '1';
		const opts = {};
		if (Object.keys(limits).length) opts.limits = limits;
		if (viaOutbound) opts.outbound = { TENANT_FROM_DISPATCH: script };
		const ns = viaOutbound ? env.DISPATCHER_OUT : env.DISPATCHER;
		const target = new URL((m[2] || '/') + url.search, url.origin);
		const t0 = Date.now();
		try {
			const user = ns.get(script, {}, opts);
			const r = await user.fetch(new Request(target, req));
			const out = new Response(r.body, r);
			out.headers.set('x-dispatch-script', script);
			out.headers.set('x-dispatch-limits', JSON.stringify(limits));
			return out;
		} catch (e) {
			const msg = String((e && e.message) || e);
			return Response.json(
				{ dispatch_error: msg, name: e && e.name, script, limits, outbound: viaOutbound, ms: Date.now() - t0 },
				{ status: msg.startsWith('Worker not found') ? 404 : 502 },
			);
		}
	},
};
