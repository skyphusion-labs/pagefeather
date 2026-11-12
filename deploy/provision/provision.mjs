// Provisioning core, the orchestration (#154). provisionSite sequences the
// idempotent ops per kind. It is the ONE place both callers use: the CLI
// (node) and the provisioning Worker both call provisionSite with the same
// ctx { acct, token, fetchImpl? }. Secrets are deployed atomically as
// secret_text bindings in the script upload (matching deploy/variants/c1.sh's
// --secrets-file), so a site never runs a request without its secrets.
import {
  createR2Bucket, deployNamespaceScript, ensureProxiedHostname, scriptExists,
  installWordPress, freshKVNamespace,
} from './ops.mjs';
import { upsertSite, readSite } from './registry.mjs';
import { assertValidName, genSecret } from './shared.mjs';

// cfg:
//   kind: 'wp' (b-dosql, PHP+SQLite in a Durable Object) or
//         'a'  (approach A, #218: PHP-WASM in the WORKER, MySQL via Hyperdrive)
//   name: site name (script is site-<name>)
//   namespace, kvId, hostname
//   compatibilityDate, compatibilityFlags
//   modules: [{ name, content }]  (the pre-built worker bundle for the kind)
//   resourceBindings: [...]       (kv/r2/do/hyperdrive/vars, NOT secrets)
//   sqliteClasses: [...]          (the SQLite DO classes to declare in a migration;
//                                  ['PhpRuntime'] for 'wp', [] for 'a' -> no migration)
//   kvNamespaces: [{ title, binding }]  (KV namespaces to CREATE then inject the id
//                                  of into the matching resourceBinding by name; the
//                                  OC_KV object-cache L2 store for approach A)
//   secrets: { NAME: value, ... } (becomes secret_text bindings)
//   buckets: { media }
// Returns a step log and the registry entry written.
//
// SECURITY (#182): both callers reach the account token through this core, so
// the name is validated HERE, not only in the CLI. name is interpolated into
// script names, bucket names and a hostname label, all of which become URL
// paths and resource ids; assertValidName is the one allowlist that bounds
// them. The trusted Worker (worker.mjs) builds the rest of the cfg itself and
// never lets a caller supply modules, bindings, a namespace, a kv id or a zone.
//
// ONE code path for both kinds (#241): 'wp' and 'a' are the SAME idempotent
// sequence (bucket, optional KV namespaces, namespace script, registry entry,
// routing record, WordPress install). The only differences are DATA, not a
// separate code path: the binding/var set the caller builds (bDosqlBindings vs
// aBindings), whether a SQLite migration is declared (sqliteClasses), and
// whether a KV namespace is created (kvNamespaces). The c1 container store
// ('shop') was retired (#214) and is not a kind.
export async function provisionSite(ctx, cfg) {
  if (cfg.kind === 'wp' || cfg.kind === 'a') return provisionNamespaceSite(ctx, cfg);
  // The c1 container store ('shop') was retired (#214): a store is a b-dosql site
  // with WooCommerce active, not a separate provisioning kind. So this core mints
  // only namespace WordPress sites, and never touches account-token minting or
  // Containers.
  throw new Error(`provisionSite: only kind 'wp' (b-dosql) and 'a' (approach A, #218) are supported; the c1 'shop' store path was retired (#214)`);
}

function secretBindings(secrets = {}) {
  return Object.entries(secrets).map(([name, text]) => ({ type: 'secret_text', name, text }));
}

// Idempotency (#182): a hostname already in the registry is returned as-is, with
// no second create and no overwrite. A registry read that returns an entry with
// a `script` field is a real, previously-provisioned site; anything else (null,
// or a bare API envelope with no script) means "not provisioned", so we build.
async function existingSite(ctx, { kvId, hostname }) {
  if (!kvId || !hostname) return null;
  const entry = await readSite(ctx, { kvId, hostname });
  return entry && typeof entry.script === 'string' ? entry : null;
}

async function provisionNamespaceSite(ctx, cfg) {
  assertValidName(cfg.name);
  const steps = [];
  const script = `site-${cfg.name}`;
  const found = await existingSite(ctx, { kvId: cfg.kvId, hostname: cfg.hostname });
  if (found) {
    const admin = found.adminUrl ? { url: found.adminUrl, user: found.adminUser || 'admin' } : undefined;
    return { kind: found.kind || cfg.kind, name: cfg.name, script: found.script, hostname: cfg.hostname, entry: found, existing: true, installed: !!found.installed, admin, steps };
  }
  // Anti-clobber (#182, grok residual 2): the hostname is not ours (idempotency
  // returned above if it were), so a script already named site-<name> in the
  // namespace is a foreign or orphaned site. Refuse rather than overwrite it.
  if (await scriptExists(ctx, { name: script, ns: cfg.namespace })) {
    throw new Error(`provisionNamespaceSite: a namespace script named ${script} already exists and is not registered for ${cfg.hostname}; refusing to clobber it`);
  }
  steps.push(await createR2Bucket(ctx, cfg.buckets.media));
  // KV namespaces (#241): approach A binds a per-site OC_KV (the object-cache L2).
  // A KV namespace id is assigned at create time, so it cannot be in the binding
  // the caller built; create each namespace now and INJECT its id into the
  // matching resourceBinding by name. Clone the bindings so cfg is not mutated.
  const bindings = [...(cfg.resourceBindings || [])];
  for (const spec of cfg.kvNamespaces || []) {
    // Fresh, never reused: this path runs only for a site that is not registered,
    // so a namespace already under this title is a leftover (see freshKVNamespace).
    const ns = await freshKVNamespace(ctx, spec.title);
    const binding = bindings.find((b) => b.type === 'kv_namespace' && b.name === spec.binding);
    if (!binding) throw new Error(`provisionNamespaceSite: kvNamespaces asked to bind ${spec.binding} but no kv_namespace binding named ${spec.binding} is in resourceBindings`);
    binding.namespace_id = ns.id;
    steps.push({ kvNamespace: spec.title, binding: spec.binding, id: ns.id, created: ns.created === true, ...(ns.replaced ? { replaced: true } : {}) });
  }

  // Descriptor resource-create ops (#201 Phase 1): an integration descriptor may
  // need a backing resource created BEFORE the script deploys (a KV namespace, a
  // queue) and may inject the created id into its own binding. Run each here, on
  // the SAME cloned `bindings` the OC_KV injection above uses, so a descriptor
  // that adds a resource composes with the rest. No default descriptor (and not
  // PDF) has one today; this is the seam the L2 KV (#218) and Queue (#190) waves
  // bind through. A step the op returns is recorded under its descriptor name.
  for (const spec of cfg.resourceCreateOps || []) {
    const step = await spec.op(ctx, { cfg, bindings });
    steps.push({ resource: spec.name, ...(step || {}) });
  }
  // sqliteClasses: the SQLite Durable Object classes the bundle defines. For
  // b-dosql that is ['PhpRuntime'], which MUST be declared in a migration or the
  // DO binding is rejected (API 10061, measured #158). Approach A runs PHP in the
  // WORKER (no DO), so it declares NO classes and NO migration. Default by kind
  // when the caller leaves it unset.
  const sqliteClasses = cfg.sqliteClasses !== undefined ? cfg.sqliteClasses : (cfg.kind === 'wp' ? ['PhpRuntime'] : []);
  await deployNamespaceScript(ctx, {
    ns: cfg.namespace,
    name: script,
    mainModule: cfg.mainModule || 'index.js',
    modules: cfg.modules,
    bindings: [...bindings, ...secretBindings(cfg.secrets)],
    compatibilityDate: cfg.compatibilityDate,
    compatibilityFlags: cfg.compatibilityFlags || [],
    migrations: { new_tag: cfg.migrationTag || 'v1', new_sqlite_classes: sqliteClasses },
  });
  steps.push({ deployed: script, ns: cfg.namespace, sqliteClasses });
  const entry = {
    script, kind: cfg.kind, outbound: true, ...(cfg.limits || {}),
    // Demo lane (#182 Path B): stamp everything the reaper needs to tear this
    // site down fully (script, bucket, zone) plus the expiry it reaps on.
    ...(cfg.demo ? { demo: true, expiresAt: cfg.expiresAt, name: cfg.name, mediaBucket: cfg.buckets.media, saasZoneId: cfg.saasZoneId } : {}),
  };
  // Routing FIRST: write the site-map entry so the dispatcher can route by Host,
  // including to the /_install request below. (installed is folded in after the
  // install so a re-provision can tell a ready site from a bare one.)
  await upsertSite(ctx, { kvId: cfg.kvId, hostname: cfg.hostname, entry });
  // A namespace site is reached through the SaaS zone's */* dispatcher (wp-dispatch).
  // For the hostname to enter the zone it needs a proxied originless record; when
  // saasZoneId is set the core places it. Idempotent: an existing record is success.
  if (cfg.saasZoneId) {
    steps.push(await ensureProxiedHostname(ctx, { zoneId: cfg.saasZoneId, hostname: cfg.hostname }));
  }
  // Install (#215): the site serves but lands at /wp-admin/install.php until the
  // WP install runs. Trigger it over HTTP against the site itself (authorized by
  // its own SPIKE_TOKEN secret, so NO new token scope), seeding the 'admin' user
  // with a fresh strong password. Idempotent server-side (already-installed is ok).
  // Approach A installs over the SAME /_install + x-spike-token path (index.js
  // handles the spike endpoints whether PHP runs in the Worker or a DO).
  const adminPassword = genSecret(16);
  const adminUrl = `https://${cfg.hostname}/wp-admin/`;
  // PRIMARY: install via the dispatch-namespace binding (ctx.dispatcher), which
  // routes straight to site-<name> and avoids the KV->dispatcher propagation 530
  // right after a deploy (#215 deploy-gate). The node CLI has no binding, so it
  // falls back to public HTTP with retries. BEST-EFFORT: a failed install does NOT
  // fail the provision; a deployed-but-uninstalled site beats a hard failure.
  let install = null, installError = null;
  try {
    install = await installWordPress({
      dispatcher: ctx.dispatcher, scriptName: script,
      hostname: cfg.hostname, spikeToken: cfg.secrets && cfg.secrets.SPIKE_TOKEN,
      adminPassword, fetchImpl: ctx.fetchImpl,
      retries: cfg.installRetries, intervalMs: cfg.installIntervalMs,
    });
  } catch (e) { installError = (e && e.message) || String(e); }
  const installed = Boolean(install && install.installed);
  steps.push(installed ? { installed: true, already: install.already, via: install.via } : { installed: false, error: installError });
  // Record install state + the admin URL/user (NEVER the password) so a re-provision
  // returns the site without re-installing.
  const finalEntry = { ...entry, installed, adminUrl, adminUser: 'admin' };
  await upsertSite(ctx, { kvId: cfg.kvId, hostname: cfg.hostname, entry: finalEntry });
  return {
    kind: cfg.kind, name: cfg.name, script, hostname: cfg.hostname, entry: finalEntry, steps,
    installed, alreadyInstalled: Boolean(install && install.already),
    // The admin password is surfaced ONLY when the install actually ran (so it is
    // valid); a deferred install returns the url + user and a note.
    admin: installed ? { url: adminUrl, user: 'admin', password: adminPassword } : { url: adminUrl, user: 'admin' },
    ...(installError ? { installNote: `install deferred (finish via /_install): ${installError}` } : {}),
  };
}
