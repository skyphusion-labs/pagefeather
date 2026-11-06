// Tests of the container fetch timeout (issue #93). Run: node spikes/c1-woo-container/tests/timeout-test.mjs
// It runs the real Store.prototype.fetch text from worker.js against a stub container that never answers.
// An optional first argument names another worker.js (to test a mutant).
// An outer deadline makes a missing timeout FAIL with exit 1; it does not hang.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const DEADLINE_MS = 15000;
const deadline = setTimeout(() => {
  console.log('FAIL deadline: no result after', DEADLINE_MS, 'ms (is the container fetch timeout gone?)');
  process.exit(1);
}, DEADLINE_MS);
const src = readFileSync(process.argv[2] || join(here, '..', 'worker.js'), 'utf8');
const cut = (a, b) => {
  const i = src.indexOf(a);
  const j = i < 0 ? -1 : src.indexOf(b, i);
  if (i < 0 || j < 0) { console.log('FAIL worker.js: marker not found:', i < 0 ? a : b); process.exit(1); }
  return src.slice(i, j);
};
const helpers = cut('const SESSION_COOKIE', 'Store.prototype.fetch = async function');
const fetchFn = cut('Store.prototype.fetch = async function', '\n};\n') + '\n};\n';
let mode = 'hang';
const Container = class {};
Container.prototype.fetch = function () {
  if (mode === 'hang') return new Promise(() => {});
  return Promise.resolve(new Response('ok'));
};
const Store = function () {};
new Function('Container', 'Store', helpers + fetchFn)(Container, Store);
const s = new Store();
s.env = { CONTAINER_TIMEOUT_S: '1', QUEUE_LIMIT: '16' };
let fails = 0;
const report = (ok, ...msg) => { if (!ok) fails++; console.log(ok ? 'PASS' : 'FAIL', ...msg); };

// 1. A shopper request to a container that never answers gets 504 after the limit, and its slot back.
const t0 = Date.now();
const r1 = await s.fetch(new Request('https://x/?rest_route=/wc/store/v1/checkout', { method: 'POST', body: '{}' }));
const t1 = Date.now() - t0;
const body = await r1.json().catch(() => ({}));
report(r1.status === 504 && body.code === 'c1_timeout' && r1.headers.get('x-c1-timeout') === '1'
  && s.queue.inflight === 0 && s.queue.timedOut === 1 && t1 >= 900 && t1 < 3000,
  'hung checkout: status', r1.status, 'after', t1, 'ms, inflight', s.queue.inflight, 'timedOut', s.queue.timedOut);

// 2. An exempt request (wp-admin) is not cut: it still waits after 2 s.
const adm = s.fetch(new Request('https://x/wp-admin/export.php'));
const won = await Promise.race([adm.then(() => 'answered'), new Promise((r) => setTimeout(() => r('still waiting'), 2000))]);
report(won === 'still waiting' && s.queue.inflight === 1, 'hung admin request is not timed out:', won, 'inflight', s.queue.inflight);

// 3. A normal answer passes through.
mode = 'ok';
const r3 = await s.fetch(new Request('https://x/?p=1'));
const txt = await r3.text();
await new Promise((r) => setTimeout(r, 50));
report(r3.status === 200 && txt === 'ok' && s.queue.inflight === 1, 'answered page: status', r3.status, 'body', txt, 'inflight (admin still held)', s.queue.inflight);

clearTimeout(deadline);
console.log(fails ? `${fails} FAIL` : 'all PASS');
process.exit(fails ? 1 : 0);
