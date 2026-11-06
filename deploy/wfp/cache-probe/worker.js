// The Workers Cache probe of deploy/wfp (issue #35, docs/wfp.md open (b)).
// One script, deployed twice by up.sh with CACHE_PROBE=1: as site-cacheprobe
// in the namespace (behind the dispatcher copy wp-cacheprobe), and as the
// normal Worker wp-cacheprobe-direct (the control: the Workers Cache is known
// to work there). Both have [cache] enabled. Each answer says when it was made;
// the edge may keep it for 120 s (cloudflare-cdn-cache-control). So two reads
// of one URL with the same "made" were served from the cache, whatever
// cf-cache-status says.
export default {
	async fetch(request) {
		const u = new URL(request.url);
		return Response.json(
			{ made: Date.now(), rand: Math.random(), path: u.pathname + u.search },
			{ headers: { 'cloudflare-cdn-cache-control': 'max-age=120', 'cache-control': 'no-cache' } },
		);
	},
};
