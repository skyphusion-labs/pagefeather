// Provisioning core, the orchestration (#154). provisionSite sequences the
// idempotent ops per kind. It is the ONE place both callers use: the CLI
// (node) and the provisioning Worker both call provisionSite with the same
// ctx { acct, token, fetchImpl? }. Secrets are deployed atomically as
// secret_text bindings in the script upload (matching deploy/variants/c1.sh's
// --secrets-file), so a site never runs a request without its secrets.
import {
  createR2Bucket, mintScopedR2Token,
  deployNamespaceScript, deployContainerWorkerFromDigest,
  ensureProxiedHostname,
} from './ops.mjs';
import { upsertSite } from './registry.mjs';

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
export async function provisionSite(ctx, cfg) {
  if (cfg.kind === 'wp') return provisionWp(ctx, cfg);
  if (cfg.kind === 'shop') return provisionShop(ctx, cfg);
  throw new Error(`provisionSite: unknown kind ${cfg.kind}`);
}

function secretBindings(secrets = {}) {
  return Object.entries(secrets).map(([name, text]) => ({ type: 'secret_text', name, text }));
}

async function provisionWp(ctx, cfg) {
  const steps = [];
  const script = `site-${cfg.name}`;
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
  const entry = { script, kind: 'wp', outbound: true, ...(cfg.limits || {}) };
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
  const steps = [];
  const script = `c1-${cfg.name}`;
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
  await deployContainerWorkerFromDigest(ctx, {
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
  steps.push({ deployed: script, imageRef: cfg.imageRef });
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
