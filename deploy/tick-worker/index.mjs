// #754: an optional start-by recheck tick target, a tiny dedicated Worker OUTSIDE any site's hostname (the default is
// the site's own /_tick; whether the object can reach that is not yet measured). Measured on #754 round 2: it answers
// in 10 to 61 ms when reached. Each contended grant within 30 s of a start-by makes one GET here. The answer is an empty 204 that no
// cache keeps. It reads nothing, stores nothing and logs nothing: a real subrequest is the whole point, because only real
// I/O moves Date.now() in a Durable Object (#752). A site uses it with START_BY_TICK_URL=https://<this Worker's host>/.
export default {
	async fetch() {
		return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', 'cloudflare-cdn-cache-control': 'no-store' } });
	},
};
