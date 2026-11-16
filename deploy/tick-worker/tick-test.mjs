// node deploy/tick-worker/tick-test.mjs: the tick Worker answers any GET with an empty 204 that no cache keeps.
import w from './index.mjs';
let fail = 0;
const ok = (n, c) => { console.log((c ? 'PASS ' : 'FAIL ') + n); if (!c) fail++; };
for (const path of ['/', '/_tick', '/anything?x=1']) {
	const r = await w.fetch(new Request('https://pf-tick.example.workers.dev' + path));
	ok(`${path}: 204`, r.status === 204);
	ok(`${path}: empty`, (await r.text()) === '');
	ok(`${path}: never stored`, r.headers.get('cache-control') === 'no-store' && r.headers.get('cloudflare-cdn-cache-control') === 'no-store');
}
process.exit(fail ? 1 : 0);
