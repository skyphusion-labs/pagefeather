// #1141: a provisioned approach A site renders the PHP overflow pool by default, the same
// rule as deploy/deploy.sh (deploy/a-settings.sh). Unset or PHP_OVERFLOW=1 declares the
// PhpRuntime class and the PHP_RUNTIME binding, with PHP_OVERFLOW=on and pool 32.
// PHP_OVERFLOW=0 opts out: no class, no binding, no overflow vars. A bad value is refused
// before the bundle is read. The CLI and the Worker both render it from aOverflowInputs.
//   node deploy/provision/tests/a-overflow-test.mjs
import { readFileSync } from 'node:fs';
import { buildServerCfg, BadRequest } from '../server-config.mjs';

const m = await import('../wp-site-config.mjs');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

const files = new Map([
  ['bundles/a/v1/index-a-lean.js', 'export default {}'],
  ['bundles/b-dosql/v1/index.js', 'export default {}'],
]);
function serverEnv(over = {}) {
  let lists = 0;
  const BUNDLES = {
    list: async ({ prefix }) => {
      lists += 1;
      return { objects: [...files.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
    get: async (key) => (files.has(key) ? { text: async () => files.get(key), arrayBuffer: async () => new TextEncoder().encode(files.get(key)).buffer } : null),
  };
  const env = {
    WFP_BASES: JSON.stringify({ 'workers.dev': { workersDev: true, subdomain: 'acme' } }),
    WFP_KV_ID: 'KV', WFP_NAMESPACE: 'pagefeather', BUNDLES,
    WP_BUNDLE_PREFIX: 'bundles/b-dosql/v1/', A_BUNDLE_PREFIX: 'bundles/a/v1/',
    ...over,
  };
  return { env, lists: () => lists };
}
const HD = 'b'.repeat(32);
async function render(over = {}) {
  const s = serverEnv(over);
  try {
    const cfg = await buildServerCfg(s.env, { kind: 'a', name: 'mystore', domain: 'workers.dev', hyperdriveId: HD, tablePrefix: 'wp_mystore_' });
    return { cfg, lists: s.lists() };
  } catch (e) {
    return { error: e, lists: s.lists() };
  }
}
const plain = (cfg, name) => cfg && (cfg.resourceBindings || []).find((b) => b.type === 'plain_text' && b.name === name);
const runtime = (cfg) => cfg && (cfg.resourceBindings || []).find((b) => b.type === 'durable_object_namespace' && b.name === 'PHP_RUNTIME');
const text = (cfg, name) => { const b = plain(cfg, name); return b ? b.text : undefined; };

{
  const r = await render();
  const rt = r.cfg && runtime(r.cfg);
  ok('default: the rendered config declares PhpRuntime', !r.error && Array.isArray(r.cfg.sqliteClasses) && r.cfg.sqliteClasses.length === 1 && r.cfg.sqliteClasses[0] === 'PhpRuntime');
  ok('default: the rendered config binds PHP_RUNTIME to class PhpRuntime', !r.error && !!rt && rt.class_name === 'PhpRuntime');
  ok('default: PHP_OVERFLOW is on and the pool is 32', !r.error && text(r.cfg, 'PHP_OVERFLOW') === 'on' && text(r.cfg, 'PHP_OVERFLOW_POOL') === '32');
  ok('default: no max-held and no depth var (the code defaults)', !r.error && !plain(r.cfg, 'PHP_OVERFLOW_MAX_HELD') && !plain(r.cfg, 'PHP_OVERFLOW_DEPTH'));
}
{
  const r = await render({ PHP_OVERFLOW: '1' });
  const rt = runtime(r.cfg);
  ok('PHP_OVERFLOW=1 matches the default (on, pool 32, PhpRuntime)', !r.error && text(r.cfg, 'PHP_OVERFLOW') === 'on' && text(r.cfg, 'PHP_OVERFLOW_POOL') === '32' && !!rt && rt.class_name === 'PhpRuntime' && r.cfg.sqliteClasses[0] === 'PhpRuntime');
}
{
  const r = await render({ PHP_OVERFLOW: '0' });
  ok('PHP_OVERFLOW=0 opts out of the class', !r.error && Array.isArray(r.cfg.sqliteClasses) && r.cfg.sqliteClasses.length === 0);
  ok('PHP_OVERFLOW=0 opts out of the binding and the overflow vars', !r.error && !runtime(r.cfg) && !(r.cfg.resourceBindings || []).some((b) => b.type === 'durable_object_namespace') && !plain(r.cfg, 'PHP_OVERFLOW') && !plain(r.cfg, 'PHP_OVERFLOW_POOL'));
}
{
  const r = await render({ PHP_OVERFLOW: 'always' });
  const rt = runtime(r.cfg);
  ok('PHP_OVERFLOW=always renders always, and still declares the pool', !r.error && text(r.cfg, 'PHP_OVERFLOW') === 'always' && text(r.cfg, 'PHP_OVERFLOW_POOL') === '32' && !!rt && rt.class_name === 'PhpRuntime' && r.cfg.sqliteClasses[0] === 'PhpRuntime');
}
{
  const r = await render({ PHP_OVERFLOW: '1', PHP_OVERFLOW_POOL: '08' });
  ok('PHP_OVERFLOW_POOL=08 renders 8 (base 10, the deploy.sh rule)', !r.error && text(r.cfg, 'PHP_OVERFLOW_POOL') === '8');
}
{
  const r = await render({ PHP_OVERFLOW: '1', PHP_OVERFLOW_MAX_HELD: 'off', PHP_OVERFLOW_DEPTH: '0' });
  ok('max-held off and depth 0 render when set', !r.error && text(r.cfg, 'PHP_OVERFLOW_MAX_HELD') === 'off' && text(r.cfg, 'PHP_OVERFLOW_DEPTH') === '0');
}
for (const over of [{ PHP_OVERFLOW: 'on' }, { PHP_OVERFLOW: '2' }, { PHP_OVERFLOW: '1', PHP_OVERFLOW_POOL: '129' }, { PHP_OVERFLOW: '0', PHP_OVERFLOW_POOL: '8' }, { PHP_OVERFLOW: '1', PHP_OVERFLOW_DEPTH: '51' }]) {
  const r = await render(over);
  ok('refused before the bundle is read: ' + JSON.stringify(over), r.error instanceof BadRequest && r.lists === 0);
}

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
for (const [f, loadName] of [['../server-config.mjs', 'await loadBundle'], ['../cli.mjs', 'await loadModules']]) {
  const s = src(f);
  const at = s.indexOf('overflow = aOverflowInputs(env)');
  const io = s.indexOf(loadName);
  ok(f + ' reads aOverflowInputs before any bundle IO', at > 0 && io > at);
  ok(f + ' spreads the overflow inputs into the approach A bindings', /aBindings\(\{[\s\S]{0,1400}\.\.\.overflow\b/.test(s));
  ok(f + ' declares PhpRuntime unless PHP_OVERFLOW is off', /sqliteClasses: overflow\.phpOverflow === 'off' \? \[\] : \['PhpRuntime'\]/.test(s));
}

const bare = m.aBindings({ mediaBucket: 'b', hyperdriveId: 'HDID', siteOrigin: 'https://s.example' });
ok('aBindings with no overflow opts emits no pool (deploy.sh renders that pool itself)', !bare.some((b) => b.name === 'PHP_OVERFLOW' || b.name === 'PHP_RUNTIME' || b.type === 'durable_object_namespace'));

const wp = await buildServerCfg(serverEnv().env, { kind: 'wp', name: 'blog', domain: 'workers.dev' });
ok('a wp site still declares its own PhpRuntime and no Hyperdrive', wp.sqliteClasses.includes('PhpRuntime') && !wp.resourceBindings.some((b) => b.type === 'hyperdrive'));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
