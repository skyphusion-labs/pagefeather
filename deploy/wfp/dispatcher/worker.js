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
//   moving       {"until": <ms epoch>}: a store move is copying the site (#479). Every request but
//                an operator /_ path answers 503 (Retry-After 120) until that time, so nothing
//                writes while the copy runs. WordPress writes on GETs too (post-new's auto-draft,
//                the edit lock, transients), so the admin is closed as well. A flag whose time has
//                passed is ignored: a move that dies does not keep the site closed. A flag that is
//                not that shape closes the site (it was set on purpose; fix the entry), and logs
//                {"m":"wfp-moving-bad","host":...} on every such request, so a monitor can catch a
//                store held closed with no end time.
//
// Answers that do not come from a site, with x-wfp-error naming the case:
//   404 no-site       no entry for this hostname: an unlisted host reaches no script
//   404 not-deployed  the entry names a script that is not in the namespace (a
//                     stale entry, for example during a removal)
//   500 bad-entry     the entry is not valid JSON, or its script is not a site-<name>
//   503 moving        a store move is copying the site (moving, above)
//   502 dispatch      any other error from the namespace
//   404 not-public    /_dbsnapshot on any host: the scheduled snapshot is reached only by this
//                     Worker's own cron, never by a visitor (the site checks SNAPSHOT_TOKEN too)
//
// The scheduled snapshot (#533, design A', phase A): a site's copy has a daily cron, and its
// [vars] name the one site it serves (SNAPSHOT_SCRIPT = "site-<name>"). scheduled() sends
// POST /_dbsnapshot to that user Worker through the plain namespace binding (not the outbound
// Worker: this is not the site's own egress), with the site's SNAPSHOT_TOKEN secret, and waits up
// to SNAPSHOT_TIMEOUT_MS (default 60000). The site dumps its database into its OWN bucket
// (spikes/b2-wordpress/db-snapshot.mjs); nothing of the site's data passes through here. Every run
// logs one line "@event snapshot {json}"; a run that did not store throws, so the cron run is a
// failure in Cron Events. The freshness check (#533) reads the bucket, not this log.
const SNAPSHOT_PATH = '/_dbsnapshot';
const SNAPSHOT_TIMEOUT_MS = 60000;
const SCRIPT = /^site-[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$/;

function fail(status, code, text) {
	return new Response(text + '\n', {
		status,
		headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-wfp-error': code },
	});
}

const MOVING_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Back soon</title></head><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:32em;margin:15vh auto;padding:0 1em;color:#1d2327"><h1 style="font-weight:400">Back soon</h1><p>This store is moving to a faster setup. It is back in a few minutes.</p></body></html>\n';

// Is the site closed for a move right now? (#479) "bad" means the flag has no usable end time.
function movingNow(site, now) {
	if (site.moving === undefined || site.moving === null || site.moving === false) return { closed: false };
	const until = site.moving && site.moving.until;
	if (Number.isInteger(until)) return { closed: now < until };
	return { closed: true, bad: true };
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
		const url = new URL(request.url);
		if (url.pathname === SNAPSHOT_PATH) return fail(404, 'not-public', 'Not found.');
		const host = url.hostname;
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
		const mv = movingNow(site, Date.now());
		if (mv.bad) console.log(JSON.stringify({ m: 'wfp-moving-bad', host }));
		if (mv.closed && !new URL(request.url).pathname.startsWith('/_')) {
			return new Response(request.method === 'HEAD' ? null : MOVING_PAGE, {
				status: 503,
				headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '120', 'x-wfp-error': 'moving' },
			});
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
	async scheduled(event, env) {
		const script = env.SNAPSHOT_SCRIPT;
		const t0 = Date.now();
		const log = (o) => console.log('@event snapshot ' + JSON.stringify({ script: script || null, scheduledTime: event && event.scheduledTime, ms: Date.now() - t0, ...o }));
		if (typeof script !== 'string' || !SCRIPT.test(script) || !env.SNAPSHOT_TOKEN) {
			log({ ok: false, error: 'not-configured' });
			throw new Error('snapshot: not configured (SNAPSHOT_SCRIPT and SNAPSHOT_TOKEN)');
		}
		const n = Number(env.SNAPSHOT_TIMEOUT_MS);
		const ms = Number.isInteger(n) && n > 0 ? n : SNAPSHOT_TIMEOUT_MS;
		let timer;
		const timeout = new Promise((_, no) => (timer = setTimeout(() => no(new Error('timeout after ' + ms + ' ms')), ms)));
		let status = 0;
		let body = null;
		try {
			const req = new Request('https://snapshot.internal' + SNAPSHOT_PATH, { method: 'POST', headers: { 'x-snapshot-token': env.SNAPSHOT_TOKEN }, signal: AbortSignal.timeout(ms) });
			const r = await Promise.race([env.DISPATCHER.get(script).fetch(req), timeout]);
			status = r.status;
			const text = await Promise.race([r.text(), timeout]);
			try {
				body = JSON.parse(text);
			} catch {
				body = { text: text.slice(0, 200) };
			}
		} catch (e) {
			const error = String((e && e.message) || e).slice(0, 200);
			log({ ok: false, error });
			throw new Error('snapshot of ' + script + ': ' + error);
		} finally {
			clearTimeout(timer);
		}
		const ok = status === 200 && body && body.ok === true;
		log({ ok, status, result: body });
		if (!ok) throw new Error('snapshot of ' + script + ': HTTP ' + status + ' ' + JSON.stringify(body).slice(0, 200));
	},
};
