// Provisioning core, the orchestration (#154). provisionSite sequences the
// idempotent ops per kind. It is the ONE place both callers use: the CLI
// (node) and the provisioning Worker both call provisionSite with the same
// ctx { acct, token, fetchImpl? }. Secrets are deployed atomically as
// secret_text bindings in the script upload (matching deploy/variants/c1.sh's
// --secrets-file), so a site never runs a request without its secrets.
import {
  createR2Bucket, deployNamespaceScript, ensureProxiedHostname, scriptExists, installWordPress,
} from './ops.mjs';
import { upsertSite, readSite } from './registry.mjs';
import { assertValidName, genSecret } from './shared.mjs';

// cfg:
//   kind: 'wp'  (the ONLY kind; the c1 'shop' store path was retired, #214)
//   name: site name (script is site-<name>)
//   namespace, kvId, hostname
//   compatibilityDate, compatibilityFlags
//   modules: [{ name, content }]  (the b-dosql worker bundle)
//   resourceBindings: [...]       (kv/r2/do/vars, NOT secrets)
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
export async function provisionSite(ctx, cfg) {
  if (cfg.kind === 'wp') return provisionWp(ctx, cfg);
  // The c1 container store ('shop') was retired (#214): a store is a b-dosql site
  // with WooCommerce active, not a separate provisioning kind. So this core mints
  // only b-dosql, and never touches account-token minting or Containers.
  throw new Error(`provisionSite: only kind 'wp' (b-dosql) is supported; the c1 'shop' store path was retired (#214)`);
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

async function provisionWp(ctx, cfg) {
  assertValidName(cfg.name);
  const steps = [];
  const script = `site-${cfg.name}`;
  const found = await existingSite(ctx, { kvId: cfg.kvId, hostname: cfg.hostname });
  if (found) {
    const admin = found.adminUrl ? { url: found.adminUrl, user: found.adminUser || 'admin' } : undefined;
    return { kind: 'wp', name: cfg.name, script: found.script, hostname: cfg.hostname, entry: found, existing: true, installed: !!found.installed, admin, steps };
  }
  // Anti-clobber (#182, grok residual 2): the hostname is not ours (idempotency
  // returned above if it were), so a script already named site-<name> in the
  // namespace is a foreign or orphaned site. Refuse rather than overwrite it.
  if (await scriptExists(ctx, { name: script, ns: cfg.namespace })) {
    throw new Error(`provisionWp: a namespace script named ${script} already exists and is not registered for ${cfg.hostname}; refusing to clobber it`);
  }
  steps.push(await createR2Bucket(ctx, cfg.buckets.media));
  // sqliteClasses: the SQLite Durable Object classes the bundle defines (for
  // b-dosql, ['PhpRuntime']). They MUST be declared in a migration or the DO
  // binding is rejected (API 10061, measured #158). Default to b-dosql's class.
  const sqliteClasses = cfg.sqliteClasses || ['PhpRuntime'];
  await deployNamespaceScript(ctx, {
    ns: cfg.namespace,
    name: script,
    mainModule: cfg.mainModule || 'index.js',
    modules: cfg.modules,
    bindings: [...(cfg.resourceBindings || []), ...secretBindings(cfg.secrets)],
    compatibilityDate: cfg.compatibilityDate,
    compatibilityFlags: cfg.compatibilityFlags || [],
    migrations: { new_tag: cfg.migrationTag || 'v1', new_sqlite_classes: sqliteClasses },
  });
  steps.push({ deployed: script, ns: cfg.namespace, sqliteClasses });
  const entry = {
    script, kind: 'wp', outbound: true, ...(cfg.limits || {}),
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
  const adminPassword = genSecret(16);
  const install = await installWordPress({
    hostname: cfg.hostname, spikeToken: cfg.secrets && cfg.secrets.SPIKE_TOKEN,
    adminPassword, fetchImpl: ctx.fetchImpl,
    retries: cfg.installRetries, intervalMs: cfg.installIntervalMs,
  });
  steps.push({ installed: true, already: install.already });
  const adminUrl = `https://${cfg.hostname}/wp-admin/`;
  // Record install state + the admin URL/user (NOT the password) so a re-provision
  // returns a ready site without re-installing. The password is surfaced once below.
  const finalEntry = { ...entry, installed: true, adminUrl, adminUser: 'admin' };
  await upsertSite(ctx, { kvId: cfg.kvId, hostname: cfg.hostname, entry: finalEntry });
  return {
    kind: 'wp', name: cfg.name, script, hostname: cfg.hostname, entry: finalEntry, steps,
    installed: true, alreadyInstalled: install.already,
    admin: { url: adminUrl, user: 'admin', password: adminPassword },
  };
}
