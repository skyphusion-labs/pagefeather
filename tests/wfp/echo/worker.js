// Trivial Worker for the dispatch hop latency test (issue #35). The same code
// runs twice: as a plain Worker on workers.dev (direct) and as a user Worker in
// the dispatch namespace (through the dispatcher).
export default {
	fetch() {
		return new Response('ok\n', { headers: { 'cache-control': 'no-store' } });
	},
};
