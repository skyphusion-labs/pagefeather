// PAGE_CACHE_PRODUCT_TTL (#706) on the one-click emitters.
// The rule is deploy/wfp lib.sh page_cache_product_var: a store renders "30" with no flag,
// a non-store renders nothing, an integer from 5 to 600 wins, anything else is refused
// before a bundle is read or an API call is made.
// A store is WOO_ACTIVE 0 or 1 (0 wins), else the one-click store flag, else the token
// woocommerce in IMPORT_PLUGINS or PLUGINS.
//   node deploy/provision/tests/page-cache-product-test.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServerCfg } from '../server-config.mjs';

const shared = await import('../wp-site-config.mjs');
const pageCacheProductTtl = typeof shared.pageCacheProductTtl === 'function'
  ? shared.pageCacheProductTtl
  : () => { throw new Error('pageCacheProductTtl is not exported'); };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PRELOAD = join(ROOT, 'deploy/tests/render-golden/cli-preload.mjs');
const BUNDLE = join(ROOT, 'deploy/tests/render-golden/bundle');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

function ttlOf(bindings) {
  const b = (bindings || []).find((x) => x && x.name === 'PAGE_CACHE_PRODUCT_TTL');
  return b ? b.text : null;
}

// ---- the one function -------------------------------------------------------
function ruled(opts) {
  try { return { text: pageCacheProductTtl(opts) }; } catch (e) { return { error: e.message }; }
}
ok('a store (WOO_ACTIVE=1) is 30', ruled({ wooActive: '1' }).text === '30');
ok('a store by IMPORT_PLUGINS is 30', ruled({ importPlugins: 'classic-editor woocommerce' }).text === '30');
ok('a store by PLUGINS is 30', ruled({ plugins: 'woocommerce' }).text === '30');
ok('not a store is nothing', ruled({}).text === null);
ok('WOO_ACTIVE=0 is nothing, even with woocommerce in PLUGINS', ruled({ wooActive: '0', plugins: 'woocommerce' }).text === null);
ok('the one-click store flag is 30 when WOO_ACTIVE is unset', ruled({ store: true }).text === '30');
ok('WOO_ACTIVE=0 wins over the store flag', ruled({ wooActive: '0', store: true }).text === null);
ok('the override wins on a store', ruled({ wooActive: '1', pageCacheProductTtl: '60' }).text === '60');
ok('the override wins on a non-store', ruled({ pageCacheProductTtl: '45' }).text === '45');
ok('a leading zero is decimal', ruled({ pageCacheProductTtl: '030' }).text === '30');
for (const bad of ['0', '4', '601', 'abc', '30s', '-5']) {
  const r = ruled({ wooActive: '1', pageCacheProductTtl: bad });
  ok(`${bad} is refused, on a store too`, typeof r.error === 'string' && /integer from 5 to 600/.test(r.error) && r.error.includes(bad));
}
{
  const r = ruled({ wooActive: 'yes' });
  ok('a bad WOO_ACTIVE is refused, not read as a non-store', typeof r.error === 'string' && /WOO_ACTIVE must be 0 or 1/.test(r.error));
}

// ---- server-config.mjs (buildServerCfg, before the bundle is read) ---------
const files = new Map([
  ['bundles/b-dosql/v1/index.js', 'export default {}'],
  ['bundles/a/v1/index-a-lean.js', 'export default {}'],
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
async function serverTtl(over, opts = {}) {
  const s = serverEnv(over);
  const cfg = await buildServerCfg(s.env, { kind: 'wp', name: 'blog', domain: 'workers.dev', ...opts });
  return { text: ttlOf(cfg.resourceBindings), lists: s.lists() };
}
const HD = 'b'.repeat(32);
const srvStore = await serverTtl({ WOO_ACTIVE: '1' });
ok('server: a store (WOO_ACTIVE=1) renders 30 with no flag', srvStore.text === '30');
const srvPlugins = await serverTtl({ IMPORT_PLUGINS: 'woocommerce' });
ok('server: a store by IMPORT_PLUGINS renders 30', srvPlugins.text === '30');
const srvNone = await serverTtl({});
ok('server: a non-store renders nothing', srvNone.text === null);
const srvOff = await serverTtl({ WOO_ACTIVE: '0', PLUGINS: 'woocommerce' });
ok('server: WOO_ACTIVE=0 renders nothing', srvOff.text === null);
const srvFlag = await serverTtl({}, { store: true });
ok('server: the one-click store flag renders 30 with no flag', srvFlag.text === '30');
const srvOver = await serverTtl({ WOO_ACTIVE: '1', PAGE_CACHE_PRODUCT_TTL: '60' });
ok('server: the override wins', srvOver.text === '60');
const srvNon = await serverTtl({ PAGE_CACHE_PRODUCT_TTL: '45' });
ok('server: the override renders on a non-store', srvNon.text === '45');
const srvA = await buildServerCfg(serverEnv().env, { kind: 'a', name: 'mystore', domain: 'workers.dev', hyperdriveId: HD, tablePrefix: 'wp_mystore_', store: true });
ok('server: kind a with the store flag renders 30', ttlOf(srvA.resourceBindings) === '30');
const srvAplain = await buildServerCfg(serverEnv().env, { kind: 'a', name: 'mystore', domain: 'workers.dev', hyperdriveId: HD, tablePrefix: 'wp_mystore_' });
ok('server: kind a without the store flag renders nothing', ttlOf(srvAplain.resourceBindings) === null);
{
  const s = serverEnv({ PAGE_CACHE_PRODUCT_TTL: '601', WOO_ACTIVE: '1' });
  let msg = '';
  try { await buildServerCfg(s.env, { kind: 'wp', name: 'blog', domain: 'workers.dev' }); } catch (e) { msg = e.message; }
  ok('server: 601 is refused before the bundle is read', /integer from 5 to 600/.test(msg) && s.lists() === 0);
}
{
  const s = serverEnv({ WOO_ACTIVE: 'yes' });
  let msg = '';
  try { await buildServerCfg(s.env, { kind: 'wp', name: 'blog', domain: 'workers.dev' }); } catch (e) { msg = e.message; }
  ok('server: a bad WOO_ACTIVE is refused before the bundle is read', /WOO_ACTIVE must be 0 or 1/.test(msg) && s.lists() === 0);
}

// ---- cli.mjs (the real process, the golden stand-in API, no network) -------
function cli(extra) {
  const cap = join(mkdtempSync(join(tmpdir(), 'pf706-')), 'cap.json');
  const r = spawnSync(process.execPath, ['--import', PRELOAD, 'deploy/provision/cli.mjs', 'add', '--kind', 'wp', 'store'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      CLOUDFLARE_ACCOUNT_ID: 'account-test', CLOUDFLARE_API_TOKEN: 'token-test-not-real',
      WFP_KV_ID: 'kv-sites-test-id', WFP_SAAS_ZONE_ID: 'zone-test-id', WFP_SUBDOMAIN: 'sub',
      WP_HOSTNAME: 'store.example.com', SITE_ORIGIN: 'https://store.example.com',
      BDOSQL_BUNDLE_DIR: BUNDLE, GOLDEN_CAPTURE: cap,
      ...extra,
    },
  });
  let calls = null;
  try { calls = JSON.parse(readFileSync(cap, 'utf8')); } catch { calls = null; }
  const put = calls && calls.find((c) => c.method === 'PUT' && /\/scripts\/site-store$/.test(c.path));
  return { status: r.status, stderr: r.stderr || '', text: put ? ttlOf(put.body.metadata.bindings) : null, put: !!put };
}
const cliStore = cli({ WOO_ACTIVE: '1' });
ok('cli: a store renders 30 with no flag', cliStore.status === 0 && cliStore.text === '30');
const cliNone = cli({});
ok('cli: a non-store renders nothing', cliNone.status === 0 && cliNone.text === null);
const cliPlug = cli({ IMPORT_PLUGINS: 'woocommerce' });
ok('cli: a store by IMPORT_PLUGINS renders 30', cliPlug.status === 0 && cliPlug.text === '30');
const cliOver = cli({ WOO_ACTIVE: '1', PAGE_CACHE_PRODUCT_TTL: '60' });
ok('cli: the override wins', cliOver.status === 0 && cliOver.text === '60');
const cliBad = cli({ WOO_ACTIVE: '1', PAGE_CACHE_PRODUCT_TTL: '601' });
ok('cli: 601 is refused before any upload', cliBad.status !== 0 && /integer from 5 to 600/.test(cliBad.stderr) && !cliBad.put);
const cliWoo = cli({ WOO_ACTIVE: 'yes' });
ok('cli: a bad WOO_ACTIVE is refused before any upload', cliWoo.status !== 0 && /WOO_ACTIVE must be 0 or 1/.test(cliWoo.stderr) && !cliWoo.put);

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
