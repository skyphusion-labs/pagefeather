// The dispatch Worker of the reference deployment (issue #35, deploy/wfp).
// One script for every site. In phase A each site has its own copy, wp-<site>
// on workers.dev, and every copy is the same code with the same bindings: the
// request's own hostname is the key into the site map (KV binding SITES).
//
// A site map entry: {"script": "site-<name>", "cpuMs": n, "subRequests": n, "outbound": true}
//   script       the user Worker in the dispatch namespace
//   cpuMs        optional per-call CPU limit (not exact below about 2 s, docs/wfp.md item 4)
//   subRequests  optional per-call subrequest limit (exact)
//   outbound     false to skip the outbound Worker (default: through it)
//
// Answers that do not come from a site, with x-wfp-error naming the case:
//   404 no-site       no entry for this hostname: an unlisted host reaches no script
//   404 not-deployed  the entry names a script that is not in the namespace (a
//                     stale entry, for example during a removal)
//   500 bad-entry     the entry is not valid JSON, or its script is not a site-<name>
//   502 dispatch      any other error from the namespace
const SCRIPT = /^site-[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$/;

function fail(status, code, text) {
	return new Response(text + '\n', {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-wfp-error': code },
	});
}

function limitsOf(site) {
	const l = {};
	for (const k of ['cpuMs', 'subRequests']) {
		if (Number.isInteger(site[k]) && site[k] > 0) l[k] = site[k];
	}
	return l;
}

export default {
	async fetch(request, env) {
		// URL already lowercases the hostname (WHATWG URL), so the site map keys are lower case.
		const host = new URL(request.url).hostname;
		const raw = await env.SITES.get(host);
		if (raw === null) return fail(404, 'no-site', 'No site at this address.');
		let site;
		try {
			site = JSON.parse(raw);
		} catch {
			return fail(500, 'bad-entry', 'This site is not configured correctly.');
		}
		if (!site || typeof site.script !== 'string' || !SCRIPT.test(site.script)) {
			return fail(500, 'bad-entry', 'This site is not configured correctly.');
		}
		const opts = {};
		const limits = limitsOf(site);
		if (Object.keys(limits).length) opts.limits = limits;
		const viaOutbound = site.outbound !== false;
		if (viaOutbound) opts.outbound = { SITE: site.script };
		const ns = viaOutbound ? env.DISPATCHER_OUT : env.DISPATCHER;
		try {
			return await ns.get(site.script, {}, opts).fetch(request);
		} catch (e) {
			const msg = String((e && e.message) || e);
			if (msg.startsWith('Worker not found')) return fail(404, 'not-deployed', 'This site is not deployed.');
			return fail(502, 'dispatch', 'This site did not answer.');
		}
	},
};
