// Test user Worker with a Container (issue #35, item 2). Uploaded into the
// dispatch namespace as "tenant-c". GET /container starts the container (the
// public Apache image docker.io/library/httpd, port 80; no local image build)
// and returns its answer.
import { Container, getContainer } from '@cloudflare/containers';

export class Box extends Container {
	defaultPort = 80;
	sleepAfter = '2m';
	constructor(ctx, env) {
		super(ctx, env);
		// The port depends on the image: BOX_PORT (a var) overrides it.
		if (env.BOX_PORT) this.defaultPort = Number(env.BOX_PORT);
	}
}

export default {
	async fetch(req, env) {
		const url = new URL(req.url);
		if (url.pathname === '/ping') return Response.json({ check: 'ping', ok: true });
		if (url.pathname !== '/container') return new Response('not found', { status: 404 });
		const t0 = Date.now();
		try {
			const r = await getContainer(env.BOX, 'one').fetch(new Request('http://box/'));
			return Response.json({ check: 'container', ok: r.ok, status: r.status, body: (await r.text()).trim(), ms: Date.now() - t0 });
		} catch (e) {
			return Response.json({ check: 'container', ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 }, { status: 500 });
		}
	},
};
