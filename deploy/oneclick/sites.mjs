// The site manager's work (#414): every site is made through deploy/provision
// (buildServerCfg, then provisionSite), the one provisioning path. This file adds
// only what a workers.dev deployment needs around it: the account and its
// workers.dev subdomain, the site map namespace, and each site's front door (a
// small plain Worker, wp-<name>, that runs deploy/wfp/dispatcher/worker.js).
import { cfFetch, opError } from './vendor/provision/cf.mjs';
import { ensureKVNamespace, scriptExists, enableWorkersDevSubdomain } from './vendor/provision/ops.mjs';
import { provisionSite } from './vendor/provision/provision.mjs';
import { readSite, listSites } from './vendor/provision/registry.mjs';
import { validateRequest, buildServerCfg, BadRequest } from './vendor/provision/server-config.mjs';
import { shown, logged } from './errors.mjs';

export const SITE_MAP_TITLE_DEFAULT = 'pagefeather-sites';
export const NAMESPACE_DEFAULT = 'pagefeather';
export const WOO_PLUGIN = 'woocommerce/woocommerce.php';

const frontDoorName = (name) => `wp-${name}`;

// The account id: ADMIN config CF_ACCOUNT_ID when set, else the ONE account the key
// reaches (an account API token reaches one). More than one, or none: refuse.
export async function accountId(env, fetchImpl) {
  if (typeof env.CF_ACCOUNT_ID === 'string' && /^[0-9a-f]{32}$/.test(env.CF_ACCOUNT_ID)) return env.CF_ACCOUNT_ID;
  const r = await cfFetch(env.PAGEFEATHER_KEY, 'GET', '/accounts?per_page=5', { fetchImpl });
  if (!r.ok) throw opError('accountId', 'accounts', r);
  const list = Array.isArray(r.result) ? r.result : [];
  if (list.length !== 1) throw new BadRequest(`the key reaches ${list.length} accounts; set CF_ACCOUNT_ID to the one to use`);
  return list[0].id;
}

// The account's workers.dev subdomain (<sub> in <worker>.<sub>.workers.dev).
export async function workersSubdomain(ctx) {
  const r = await cfFetch(ctx.token, 'GET', `/accounts/${ctx.acct}/workers/subdomain`, { fetchImpl: ctx.fetchImpl });
  if (!r.ok) throw opError('workersSubdomain', ctx.acct, r);
  const sub = r.result && r.result.subdomain;
  if (typeof sub !== 'string' || !sub) throw new BadRequest('this account has no workers.dev subdomain yet');
  return sub;
}

// Everything a request needs, resolved once per request. The key is a secret on
// this Worker; it never leaves it and is never written into a response.
export async function context(env, fetchImpl) {
  if (typeof env.PAGEFEATHER_KEY !== 'string' || !env.PAGEFEATHER_KEY) throw new BadRequest('the key is not set');
  const acct = await accountId(env, fetchImpl);
  const ctx = { acct, token: env.PAGEFEATHER_KEY, dispatcher: env.DISPATCHER, fetchImpl };
  return ctx;
}

async function siteMap(ctx, env) {
  return (await ensureKVNamespace(ctx, env.SITE_MAP_TITLE || SITE_MAP_TITLE_DEFAULT)).id;
}

// The env that buildServerCfg reads, built here from this Worker's own config and
// the live account, never from the request. The base is the workers.dev base.
function provisionEnv(env, { kvId, subdomain }) {
  return {
    ...env,
    WFP_KV_ID: kvId,
    WFP_NAMESPACE: env.WFP_NAMESPACE || NAMESPACE_DEFAULT,
    WFP_BASES: JSON.stringify({ 'workers.dev': { workersDev: true, subdomain } }),
    WP_BUNDLE_PREFIX: bundlePrefix(env),
  };
}

// The site's front door: a plain Worker with the shared dispatcher code, bound to
// the site map and the namespace, on its own workers.dev route. outbound is off in
// the site entry, so DISPATCHER_OUT is not bound.
export async function deployFrontDoor(ctx, { name, kvId, namespace, source, compatibilityDate }) {
  const script = frontDoorName(name);
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: compatibilityDate,
    bindings: [
      { type: 'kv_namespace', name: 'SITES', namespace_id: kvId },
      { type: 'dispatch_namespace', name: 'DISPATCHER', namespace },
    ],
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.js', new Blob([source], { type: 'application/javascript+module' }), 'worker.js');
  const r = await cfFetch(ctx.token, 'PUT', `/accounts/${ctx.acct}/workers/scripts/${script}`, { body: form, fetchImpl: ctx.fetchImpl });
  if (!r.ok) throw opError('deployFrontDoor', script, r);
  await enableWorkersDevSubdomain(ctx, script);
  return { frontDoor: script };
}

// Turn on WooCommerce through the site's own /_activate, reached through the
// dispatch binding (no public DNS race), authorized by the site's SPIKE_TOKEN.
export async function activateWoo(ctx, { script, spikeToken }) {
  if (!ctx.dispatcher || typeof ctx.dispatcher.get !== 'function') return { activated: false, ref: logged('WooCommerce activation', 'no dispatch binding') };
  try {
    const res = await ctx.dispatcher.get(script).fetch(new Request(`https://internal/_activate?plugin=${encodeURIComponent(WOO_PLUGIN)}`, {
      method: 'POST', headers: { 'x-spike-token': spikeToken },
    }));
    // /_activate answers { out: <PHP output> }, and the PHP output ends with
    // json_encode(['active' => is_plugin_active(...), ...]) (spikes/b2-wordpress/index.js).
    let out = '';
    try { const body = await res.json(); out = typeof body.out === 'string' ? body.out : ''; } catch { out = ''; }
    const activated = res.ok && /"active":true/.test(out);
    if (activated) return { activated: true };
    return { activated: false, ref: logged('WooCommerce activation', `HTTP ${res.status}: ${out.slice(-500)}`) };
  } catch (e) { return { activated: false, ref: logged('WooCommerce activation', (e && e.stack) || e) }; }
}

// Add a site. body: { name, store }. Returns what the success screen shows.
// The request chooses a name and a checkbox; it configures nothing else.
export async function addSite(env, { body, fetchImpl, dispatcherSource }) {
  if (!body || typeof body !== 'object') throw new BadRequest('body must be a JSON object');
  const store = body.store === true;
  // The same validation the operator Worker uses: the name rule and the caller-reserved names.
  const req = validateRequest({ kind: 'wp', name: body.name, domain: 'workers.dev' });
  const ctx = await context(env, fetchImpl);
  const kvId = await siteMap(ctx, env);
  const subdomain = await workersSubdomain(ctx);
  const penv = provisionEnv(env, { kvId, subdomain });
  const namespace = penv.WFP_NAMESPACE;
  const hostname = `wp-${req.name}.${subdomain}.workers.dev`;

  // Anti-clobber: a wp-<name> Worker that exists and is not in our site map is the
  // owner's own Worker. Refuse BEFORE anything is made.
  const existing = await readSite(ctx, { kvId, hostname });
  const ours = existing && typeof existing.script === 'string';
  if (!ours && await scriptExists(ctx, { name: frontDoorName(req.name) })) {
    throw new BadRequest(`a Worker named ${frontDoorName(req.name)} already exists in this account; pick another site name`);
  }

  const cfg = await buildServerCfg(penv, { kind: 'wp', name: req.name, domain: 'workers.dev', codeLock: true });
  cfg.outbound = false;
  const r = await provisionSite(ctx, cfg);
  await deployFrontDoor(ctx, { name: req.name, kvId, namespace, source: dispatcherSource, compatibilityDate: cfg.compatibilityDate });

  let woo = null;
  if (store && !r.existing) woo = await activateWoo(ctx, { script: r.script, spikeToken: cfg.secrets.SPIKE_TOKEN });
  return {
    ok: true, name: req.name, existing: !!r.existing, installed: !!r.installed,
    url: `https://${hostname}/`, loginUrl: `https://${hostname}/wp-login.php`,
    user: r.admin && r.admin.user, password: r.admin && r.admin.password,
    store, woo,
    // The install note can carry an upstream message, so it is logged, not shown.
    ...(r.installNote ? { note: `WordPress did not finish installing. Open the site to finish it (reference ${logged('install', r.installNote)}).` } : {}),
  };
}

// The site list, from the site map. Bounded, so a large map cannot run away.
export async function siteList(env, { fetchImpl, max = 100 }) {
  const ctx = await context(env, fetchImpl);
  const kvId = await siteMap(ctx, env);
  const keys = (await listSites(ctx, { kvId })).slice(0, max);
  const out = [];
  for (const hostname of keys) {
    const e = await readSite(ctx, { kvId, hostname });
    if (!e || typeof e.script !== 'string') continue;
    out.push({ hostname, name: e.script.replace(/^site-/, ''), installed: !!e.installed, adminUrl: e.adminUrl || `https://${hostname}/wp-admin/` });
  }
  return out;
}

// Site Health: each setup step, checked live. A check that cannot be made reads
// "todo", never "done".
export async function health(env, { fetchImpl }) {
  const checks = [];
  const add = (id, ok, detail) => checks.push({ id, ok: ok === true, detail: detail || '' });
  let ctx = null;
  try { ctx = await context(env, fetchImpl); add('key', true); } catch (e) { add('key', false, shown(e, 'health key').message); }
  if (ctx) {
    const ns = env.WFP_NAMESPACE || NAMESPACE_DEFAULT;
    const r = await cfFetch(ctx.token, 'GET', `/accounts/${ctx.acct}/workers/dispatch/namespaces/${ns}`, { fetchImpl });
    add('platforms', r.ok, r.ok ? '' : `HTTP ${r.status}`);
    try { add('subdomain', true, await workersSubdomain(ctx)); } catch (e) { add('subdomain', false, shown(e, 'health subdomain').message); }
  } else {
    add('platforms', false, 'the key is needed first');
    add('subdomain', false, 'the key is needed first');
  }
  let files = false;
  try { const l = env.BUNDLES ? await env.BUNDLES.list({ prefix: bundlePrefix(env), limit: 1 }) : null; files = !!(l && l.objects && l.objects.length); } catch { files = false; }
  add('files', files);
  return checks;
}

export function bundlePrefix(env) {
  return env.WP_BUNDLE_PREFIX || `bundles/b-dosql/${env.BUNDLE_VERSION || 'current'}/`;
}
