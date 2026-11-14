// The site manager's work (#414): every site is made through deploy/provision
// (buildServerCfg, then provisionSite), the one provisioning path. This file adds
// only what a workers.dev deployment needs around it: the account and its
// workers.dev subdomain, the site map namespace, and each site's front door (a
// small plain Worker, wp-<name>, that runs deploy/wfp/dispatcher/worker.js).
import { cfFetch, opError } from './vendor/provision/cf.mjs';
import { ensureKVNamespace, scriptExists, enableWorkersDevSubdomain, deleteNamespaceScript, deleteR2Bucket, deleteKVNamespaceByTitle } from './vendor/provision/ops.mjs';
import { provisionSite } from './vendor/provision/provision.mjs';
import { readSite, listSites, upsertSite, removeSite, updateSite } from './vendor/provision/registry.mjs';
import { validateRequest, buildServerCfg, BadRequest, HYPERDRIVE_ID_RE, TABLE_PREFIX_RE } from './vendor/provision/server-config.mjs';
import { mediaBucketName, ocKvNamespaceName } from './vendor/provision/wp-site-config.mjs';
import { shown, logged } from './errors.mjs';

export const SITE_MAP_TITLE_DEFAULT = 'pagefeather-sites';
export const NAMESPACE_DEFAULT = 'pagefeather';
export const WOO_PLUGIN = 'woocommerce/woocommerce.php';

const frontDoorName = (name) => `wp-${name}`;

// ---- Databases for the Hyperdrive store (#431) ---------------------------------
// A connected database is a Hyperdrive configuration the OWNER made in the
// Cloudflare dashboard, where Cloudflare takes the database password. The manager
// stores only its ID and the non-secret fields below, in the site map under keys
// that start with DB_KEY_PREFIX (no hostname starts with "_", so a site lookup and
// the front door never read one). It never asks for, sees or stores a password:
// reading a configuration back never returns it (Cloudflare API reference,
// "Get Hyperdrive Configuration": the password is write-only).
export const DB_KEY_PREFIX = '_db/';
// The providers the store choice offers (#431 ruling 2: PlanetScale is left out; it
// completed 0 orders under concurrent checkout, docs/results.md 2026-11-09).
export const PROVIDERS = { azure: 'Azure Database for MySQL', mysql: 'Another MySQL 8' };

// Read one Hyperdrive configuration and check it is a MySQL origin with caching off.
// Returns ONLY { id, name, host, database }; nothing else from the answer is kept.
export async function readHyperdrive(ctx, id) {
  if (typeof id !== 'string' || !HYPERDRIVE_ID_RE.test(id)) throw new BadRequest('That is not a Hyperdrive configuration ID. Copy the ID (32 letters and numbers) from Cloudflare.');
  const r = await cfFetch(ctx.token, 'GET', `/accounts/${ctx.acct}/hyperdrive/configs/${id}`, { fetchImpl: ctx.fetchImpl });
  if (r.status === 404) throw new BadRequest('No Hyperdrive configuration has that ID in this account.');
  if (r.status === 401 || r.status === 403) throw new BadRequest('The key cannot read Hyperdrive configurations. Add Hyperdrive Read to the key (see Site Health).');
  if (!r.ok) throw opError('readHyperdrive', id, r);
  const c = r.result || {};
  const o = c.origin || {};
  if (o.scheme !== 'mysql') throw new BadRequest(`This configuration is for ${typeof o.scheme === 'string' && o.scheme ? o.scheme : 'an unknown database'}, not MySQL. A store needs MySQL.`);
  if (!(c.caching && c.caching.disabled === true)) throw new BadRequest('Caching is on for this configuration. Turn caching off for it in Cloudflare, then connect it again. With caching on, a store can show old prices and stock.');
  return { id, name: String(c.name || ''), host: String(o.host || ''), database: String(o.database || '') };
}

// Connect a database: body { hyperdriveId, provider }.
export async function connectDatabase(env, { body, fetchImpl }) {
  if (!body || typeof body !== 'object') throw new BadRequest('body must be a JSON object');
  if (!Object.hasOwn(PROVIDERS, body.provider)) throw new BadRequest('Choose where the database runs.');
  const ctx = await context(env, fetchImpl);
  const kvId = await siteMap(ctx, env);
  const hd = await readHyperdrive(ctx, typeof body.hyperdriveId === 'string' ? body.hyperdriveId.trim().toLowerCase() : '');
  const entry = { ...hd, provider: body.provider, connectedAt: new Date().toISOString() };
  await upsertSite(ctx, { kvId, hostname: DB_KEY_PREFIX + hd.id, entry });
  return { ok: true, database: entry };
}

// The connected databases, and which sites use each.
export async function databaseList(env, { fetchImpl, max = 50 }) {
  const ctx = await context(env, fetchImpl);
  const kvId = await siteMap(ctx, env);
  const keys = (await listSites(ctx, { kvId, prefix: DB_KEY_PREFIX })).slice(0, max);
  const out = [];
  for (const k of keys) {
    const e = await readSite(ctx, { kvId, hostname: k });
    if (!e || typeof e.id !== 'string' || !HYPERDRIVE_ID_RE.test(e.id)) continue;
    out.push({ id: e.id, name: e.name || '', host: e.host || '', database: e.database || '', provider: Object.hasOwn(PROVIDERS, e.provider) ? e.provider : 'mysql' });
  }
  return out;
}

async function sitesUsing(ctx, kvId, id) {
  const keys = (await listSites(ctx, { kvId })).filter((k) => !k.startsWith(DB_KEY_PREFIX));
  const users = [];
  for (const k of keys) {
    const e = await readSite(ctx, { kvId, hostname: k });
    if (e && e.database === id) users.push(k);
  }
  return users;
}

// Disconnect a database: refused while any site uses it. The configuration itself
// stays in Cloudflare (the owner made it); only the manager's record goes.
export async function disconnectDatabase(env, { body, fetchImpl }) {
  const id = body && typeof body.id === 'string' ? body.id : '';
  if (!HYPERDRIVE_ID_RE.test(id)) throw new BadRequest('That is not a connected database.');
  const ctx = await context(env, fetchImpl);
  const kvId = await siteMap(ctx, env);
  const users = await sitesUsing(ctx, kvId, id);
  if (users.length) throw new BadRequest(`This database is used by ${users.length === 1 ? 'a site' : `${users.length} sites`} (${users.join(', ')}). Remove ${users.length === 1 ? 'it' : 'them'} first.`);
  await removeSite(ctx, { kvId, hostname: DB_KEY_PREFIX + id });
  return { ok: true, id };
}

// The table prefix for a Hyperdrive store: from the site name, so several stores
// share one database without touching each other's tables.
export function tablePrefixFor(name) {
  const p = `wp_${String(name).replace(/-/g, '_')}_`;
  if (!TABLE_PREFIX_RE.test(p)) throw new BadRequest('This site name cannot be used for a Hyperdrive store. Pick a shorter name.');
  return p;
}

// The store recommendation (#431): "more than 5" people checking out at the same
// moment recommends the Hyperdrive store. The cut comes from docs/results.md
// (2026-11-09): 5 concurrent, p50 4.3 s on the standard store; 25, 28.1 s.
export const CONCURRENT_CHECKOUT_CUT = 5;
export function recommendTier(concurrency) {
  return concurrency === 'more' ? 'a' : 'wp';
}

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
    A_BUNDLE_PREFIX: aBundlePrefix(env),
  };
}

// Undo a Hyperdrive store that failed part way (#431): newest first, each step on
// its own, so one failure does not stop the rest. It never touches the database or
// the Hyperdrive configuration (the owner made both). Only called for a site that
// did not exist before this request (the anti-clobber check above it proved the
// front door was not someone else's Worker). Returns what could not be removed.
async function undoStore(ctx, { name, kvId, namespace, hostname }) {
  const left = [];
  const step = async (what, fn) => { try { await fn(); } catch (e) { left.push(`${what} (reference ${logged(`undo ${what}`, (e && e.stack) || e)})`); } };
  await step('the front door', async () => {
    const r = await cfFetch(ctx.token, 'DELETE', `/accounts/${ctx.acct}/workers/scripts/${frontDoorName(name)}`, { fetchImpl: ctx.fetchImpl });
    if (!r.ok && r.status !== 404) throw opError('undo frontDoor', name, r);
  });
  await step('the site entry', () => removeSite(ctx, { kvId, hostname }));
  await step('the site code', () => deleteNamespaceScript(ctx, { ns: namespace, name: `site-${name}` }));
  await step('the object cache', () => deleteKVNamespaceByTitle(ctx, ocKvNamespaceName(name)));
  await step('the media bucket', () => deleteR2Bucket(ctx, mediaBucketName(name)));
  return left;
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

// Add a site. body: { name, store, tier, database }. Returns what the success screen
// shows. The request chooses a name, a checkbox, the store kind and (for a
// Hyperdrive store) one of the manager's own connected databases by ID; it
// configures nothing else. The Hyperdrive ID that reaches the site comes from the
// manager's checked record, read again here, never straight from the body.
export async function addSite(env, { body, fetchImpl, dispatcherSource }) {
  if (!body || typeof body !== 'object') throw new BadRequest('body must be a JSON object');
  const kind = body.tier === 'a' ? 'a' : 'wp';
  // A Hyperdrive store is always a store.
  const store = kind === 'a' ? true : body.store === true;
  // The same validation the operator Worker uses: the name rule and the caller-reserved names.
  const req = validateRequest({ kind, name: body.name, domain: 'workers.dev' }, { kinds: ['wp', 'a'] });
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

  let aOpts = {};
  let db = null;
  if (kind === 'a') {
    const id = typeof body.database === 'string' ? body.database : '';
    db = HYPERDRIVE_ID_RE.test(id) ? await readSite(ctx, { kvId, hostname: DB_KEY_PREFIX + id }) : null;
    if (!db || db.id !== id) throw new BadRequest('Choose a connected database. Connect one in Databases first.');
    // Read it again now: the configuration may have changed since it was connected.
    await readHyperdrive(ctx, db.id);
    aOpts = { hyperdriveId: db.id, tablePrefix: tablePrefixFor(req.name) };
  }
  const cfg = await buildServerCfg(penv, { kind, name: req.name, domain: 'workers.dev', codeLock: true, ...aOpts });
  cfg.outbound = false;

  if (kind === 'wp') {
    const r = await provisionSite(ctx, cfg);
    await deployFrontDoor(ctx, { name: req.name, kvId, namespace, source: dispatcherSource, compatibilityDate: cfg.compatibilityDate });
    let woo = null;
    if (store && !r.existing) woo = await activateWoo(ctx, { script: r.script, spikeToken: cfg.secrets.SPIKE_TOKEN });
    return {
      ok: true, name: req.name, existing: !!r.existing, installed: !!r.installed,
      url: `https://${hostname}/`, loginUrl: `https://${hostname}/wp-login.php`,
      user: r.admin && r.admin.user, password: r.admin && r.admin.password,
      store, woo, tier: 'wp',
      // The install note can carry an upstream message, so it is logged, not shown.
      ...(r.installNote ? { note: `WordPress did not finish installing. Open the site to finish it (reference ${logged('install', r.installNote)}).` } : {}),
    };
  }

  // The Hyperdrive store. Any failure before it is installed undoes what this
  // request made (undoStore); a failed install counts, because for a store it
  // almost always means WordPress could not reach the database.
  // A prefix that already holds WordPress is REFUSED (lead ruling on #483): using
  // it would bind the new store to another site's data and admin. The manager
  // cannot query the database itself (it has no Hyperdrive binding), so the check
  // is the site's own install answer ("already"), read before the front door
  // exists; the store is then undone like any other failure.
  let r;
  let taken = false;
  try {
    r = await provisionSite(ctx, cfg);
    if (!r.existing && r.alreadyInstalled) { taken = true; throw new Error(`table prefix ${aOpts.tablePrefix} already holds WordPress`); }
    if (!r.existing && !r.installed) throw new Error(`install: ${r.installNote || 'not installed'}`);
    await deployFrontDoor(ctx, { name: req.name, kvId, namespace, source: dispatcherSource, compatibilityDate: cfg.compatibilityDate });
    await updateSite(ctx, { kvId, hostname, patch: { database: db.id, tablePrefix: aOpts.tablePrefix } });
  } catch (e) {
    if (ours) throw e;
    const ref = logged('add Hyperdrive store', (e && e.stack) || e);
    const left = await undoStore(ctx, { name: req.name, kvId, namespace, hostname });
    const leftText = left.length ? `These could not be removed, remove them in Cloudflare: ${left.join('; ')}.` : 'Everything it had made in Cloudflare was removed.';
    if (taken) {
      throw new BadRequest(`The store was not made: the database already holds a WordPress site under the table prefix ${aOpts.tablePrefix}. Choose a database with no WordPress tables under that prefix (a separate database per store is best), or pick another site name, or remove those tables first. The site manager did not change those tables. ${leftText} (reference ${ref})`);
    }
    throw new BadRequest(`The store was not made (reference ${ref}). ${left.length ? `These could not be removed, remove them in Cloudflare: ${left.join('; ')}.` : 'Everything it had made in Cloudflare was removed.'} Your database was not changed by the removal; tables WordPress already wrote stay in it under the prefix ${aOpts.tablePrefix}.`);
  }
  const woo = r.existing ? null : await activateWoo(ctx, { script: r.script, spikeToken: cfg.secrets.SPIKE_TOKEN });
  return {
    ok: true, name: req.name, existing: !!r.existing, installed: !!r.installed,
    url: `https://${hostname}/`, loginUrl: `https://${hostname}/wp-login.php`,
    user: r.admin && r.admin.user, password: r.admin && r.admin.password,
    store: true, woo, tier: 'a', tablePrefix: aOpts.tablePrefix,
  };
}

// The site list, from the site map. Bounded, so a large map cannot run away.
export async function siteList(env, { fetchImpl, max = 100 }) {
  const ctx = await context(env, fetchImpl);
  const kvId = await siteMap(ctx, env);
  const keys = (await listSites(ctx, { kvId })).filter((k) => !k.startsWith(DB_KEY_PREFIX)).slice(0, max);
  const out = [];
  for (const hostname of keys) {
    const e = await readSite(ctx, { kvId, hostname });
    if (!e || typeof e.script !== 'string') continue;
    out.push({ hostname, name: e.script.replace(/^site-/, ''), installed: !!e.installed, adminUrl: e.adminUrl || `https://${hostname}/wp-admin/`, tier: e.kind === 'a' ? 'a' : 'wp' });
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
  // Hyperdrive store rows (#431): optional, so a blog-only owner is not told to do them.
  if (ctx) {
    const r = await cfFetch(ctx.token, 'GET', `/accounts/${ctx.acct}/hyperdrive/configs?per_page=1`, { fetchImpl });
    checks.push({ id: 'hyperdrive', ok: r.ok, detail: r.ok ? '' : `HTTP ${r.status}`, optional: true });
  } else {
    checks.push({ id: 'hyperdrive', ok: false, detail: 'the key is needed first', optional: true });
  }
  let filesA = false;
  try { const l = env.BUNDLES ? await env.BUNDLES.list({ prefix: aBundlePrefix(env), limit: 1 }) : null; filesA = !!(l && l.objects && l.objects.length); } catch { filesA = false; }
  checks.push({ id: 'filesA', ok: filesA, detail: '', optional: true });
  return checks;
}

export function bundlePrefix(env) {
  return env.WP_BUNDLE_PREFIX || `bundles/b-dosql/${env.BUNDLE_VERSION || 'current'}/`;
}

// The approach-A bundle for the Hyperdrive store (#431), beside the b-dosql one.
export function aBundlePrefix(env) {
  return env.A_BUNDLE_PREFIX || `bundles/a/${env.BUNDLE_VERSION || 'current'}/`;
}
