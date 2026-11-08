// Provisioning core, the orchestration (#154). provisionSite sequences the
// idempotent ops per kind. It is the ONE place both callers use: the CLI
// (node) and the provisioning Worker both call provisionSite with the same
// ctx { acct, token, fetchImpl? }. Secrets are deployed atomically as
// secret_text bindings in the script upload (matching deploy/variants/c1.sh's
// --secrets-file), so a site never runs a request without its secrets.
import {
  createR2Bucket, mintScopedR2Token,
  deployNamespaceScript, deployContainerWorkerFromDigest,
  ensureProxiedHostname, enableWorkersDevSubdomain, scriptExists,
} from './ops.mjs';
import { upsertSite, readSite } from './registry.mjs';
import { assertValidName } from './shared.mjs';

// cfg:
//   kind: 'wp' | 'shop'
//   name: site name (script is site-<name> for wp, c1-<name> for shop)
//   namespace, kvId, hostname
//   compatibilityDate, compatibilityFlags
//   modules: [{ name, content }]  (the b-dosql or c1 worker bundle)
//   resourceBindings: [...]       (kv/r2/do/vars, NOT secrets)
//   secrets: { NAME: value, ... } (becomes secret_text bindings)
//   buckets: { media, db? }
//   shop only: imageRef (pushed digest), containerClass, instanceType, tokenName, limits?
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
  if (cfg.kind === 'shop') return provisionShop(ctx, cfg);
  throw new Error(`provisionSite: unknown kind ${cfg.kind}`);
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
  if (found) return { kind: 'wp', name: cfg.name, script: found.script, hostname: cfg.hostname, entry: found, existing: true, steps };
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
  await upsertSite(ctx, { kvId: cfg.kvId, hostname: cfg.hostname, entry });
  // Routing: a namespace site is reached through the SaaS zone's */* dispatcher
  // (wp-dispatch), which routes by Host through this KV map. For the hostname to
  // enter the zone it needs a proxied originless record. When saasZoneId is set,
  // the core places it, so a Worker can provision a reachable site with no
  // operator step. Idempotent: an existing record is success.
  if (cfg.saasZoneId) {
    steps.push(await ensureProxiedHostname(ctx, { zoneId: cfg.saasZoneId, hostname: cfg.hostname }));
  }
  return { kind: 'wp', name: cfg.name, script, hostname: cfg.hostname, entry, steps };
}

async function provisionShop(ctx, cfg) {
  assertValidName(cfg.name);
  const steps = [];
  const script = `c1-${cfg.name}`;
  const found = await existingSite(ctx, { kvId: cfg.kvId, hostname: cfg.hostname });
  if (found) return { kind: 'shop', name: cfg.name, script: found.script, hostname: cfg.hostname, entry: found, existing: true, steps };
  // Anti-clobber (#182, grok residual 2): a standalone Worker already named
  // c1-<name> that is not registered for this hostname is foreign. A plain
  // /workers/scripts PUT would silently overwrite it, so refuse.
  if (await scriptExists(ctx, { name: script })) {
    throw new Error(`provisionShop: a Worker named ${script} already exists and is not registered for ${cfg.hostname}; refusing to clobber it`);
  }
  // Buckets first.
  steps.push(await createR2Bucket(ctx, cfg.buckets.db));
  steps.push(await createR2Bucket(ctx, cfg.buckets.media));
  // Token BEFORE the deploy, so the Litestream S3 creds go in atomically. The
  // secret is SHA-256(token value) with no trailing newline (enforced in the
  // op); a wrong newline here is exactly the #154 fresh-store boot crash.
  const tok = await mintScopedR2Token(ctx, { name: cfg.tokenName || `${script}-litestream`, bucket: cfg.buckets.db });
  const secrets = {
    ...cfg.secrets,
    LITESTREAM_ACCESS_KEY_ID: tok.accessKeyId,
    LITESTREAM_SECRET_ACCESS_KEY: tok.secretAccessKey,
  };
  const dep = await deployContainerWorkerFromDigest(ctx, {
    name: script,
    mainModule: cfg.mainModule || 'worker.js',
    modules: cfg.modules,
    bindings: [...(cfg.resourceBindings || []), ...secretBindings(secrets)],
    compatibilityDate: cfg.compatibilityDate,
    compatibilityFlags: cfg.compatibilityFlags || [],
    containerClass: cfg.containerClass || 'Store',
    imageRef: cfg.imageRef,
    instanceType: cfg.instanceType || 'basic',
  });
  steps.push({ deployed: script, imageRef: cfg.imageRef, application: dep.application });
  // A standalone shop is reached on its own workers.dev hostname; the raw
  // script PUT does not enable that route, so enable it (#158).
  steps.push(await enableWorkersDevSubdomain(ctx, script));
  // A shop is a standalone Worker with its own hostname; the registry entry
  // records it and its resources (the dispatcher does NOT route shops). The
  // token VALUE is never stored, only its id, for later revocation.
  const entry = {
    script, kind: 'shop', hostname: cfg.hostname,
    resources: { dbBucket: cfg.buckets.db, mediaBucket: cfg.buckets.media, litestreamTokenId: tok.tokenId },
  };
  await upsertSite(ctx, { kvId: cfg.kvId, hostname: cfg.hostname, entry });
  return { kind: 'shop', name: cfg.name, script, hostname: cfg.hostname, entry, steps };
}
