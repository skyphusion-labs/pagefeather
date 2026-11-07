// The "attacker" user Worker of slice 4 (issue #35): our own site A, uploaded
// with A's exact bindings and secrets, which reports what it can reach. It
// uses only what a customer's user Worker legitimately holds: its own MEDIA
// (R2), its own PHP_RUNTIME (a Durable Object), Images, its env, and fetch().
// It makes no attempt to escape the isolate or to name another tenant: every
// reach is through a binding it holds or a fetch() to a URL the run gives it.
//
//   GET /_probe/r2            list A's own MEDIA bucket: the keys it sees
//   GET /_probe/r2-fetch?u=   fetch() a URL (B's bucket object): the status
//   GET /_probe/do            A's own object marker (ctx.storage), set once
//   GET /_probe/secret        the NAMES A's env has, and a short hash of WP_SALT
//                             (never the value), so the run can tell A's salt from B's
//   GET /_probe/cpu?ms=N      busy-loop about N ms of CPU; report the ms reached
//   GET /_probe/sub?n=N&u=    fetch() the URL n times; report how many succeeded
// Behind the dispatcher, the dispatcher's cpuMs and subRequests apply, so /cpu
// and /sub show where the platform cuts A off.
export class PhpRuntime {
	constructor(ctx) { this.ctx = ctx; }
	async fetch() {
		let m = await this.ctx.storage.get('marker');
		if (!m) { m = 'obj-' + Math.random().toString(36).slice(2); await this.ctx.storage.put('marker', m); }
		return Response.json({ marker: m });
	}
}

async function hash(s) {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s || ''));
	return [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		const p = url.pathname;
		try {
			if (p === '/_probe/r2') {
				const l = await env.MEDIA.list();
				return Response.json({ keys: l.objects.map((o) => o.key).sort() });
			}
			if (p === '/_probe/r2-fetch') {
				const r = await fetch(url.searchParams.get('u'));
				const body = await r.text();
				return Response.json({ status: r.status, bytes: body.length });
			}
			if (p === '/_probe/do') {
				const id = env.PHP_RUNTIME.idFromName('a');
				return await env.PHP_RUNTIME.get(id).fetch(new Request('https://do/'));
			}
			if (p === '/_probe/secret') {
				const names = Object.keys(env).filter((k) => typeof env[k] === 'string').sort();
				return Response.json({ env_names: names, wp_salt_hash: await hash(env.WP_SALT) });
			}
			if (p === '/_probe/cpu') {
				const want = Number(url.searchParams.get('ms') || 100);
				const t0 = Date.now();
				let x = 0;
				while (Date.now() - t0 < want) { for (let i = 0; i < 1e5; i++) x += i; }
				return Response.json({ ms: Date.now() - t0, x });
			}
			if (p === '/_probe/sub') {
				const n = Number(url.searchParams.get('n') || 1);
				const u = url.searchParams.get('u');
				let ok = 0;
				let err = null;
				try { for (let i = 0; i < n; i++) { await fetch(u + '?i=' + i); ok++; } } catch (e) { err = String((e && e.message) || e); }
				return Response.json({ requested: n, ok, error: err });
			}
			return new Response('attacker probe', { status: 404 });
		} catch (e) {
			return Response.json({ error: String((e && e.message) || e) }, { status: 500 });
		}
	},
};
