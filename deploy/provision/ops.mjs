// Provisioning core, the idempotent operations (#154). Each op is a pure
// Cloudflare API call built on cf.mjs, safe to re-run for the same site, and
// callable identically from a node CLI or from inside a provisioning Worker.
// A ctx is { acct, token, fetchImpl? }.
import {
  cfFetch, sha256Hex, opError,
  R2_ITEM_READ, R2_ITEM_WRITE, r2BucketResource,
} from './cf.mjs';

// 1. R2 bucket. Create one; an already-existing bucket is success (idempotent).
export async function createR2Bucket(ctx, name) {
  const r = await cfFetch(ctx.token, 'POST', `/accounts/${ctx.acct}/r2/buckets`,
    { body: { name }, fetchImpl: ctx.fetchImpl });
  if (r.ok) return { name, created: true };
  // 10004 = bucket already exists; a 409 is the same case.
  if (r.status === 409 || r.errors.some((e) => e.code === 10004)) return { name, created: false, existed: true };
  throw opError('createR2Bucket', name, r);
}

// 2. A scoped R2 token for Litestream: read + write on EXACTLY one bucket.
// Returns the S3 cred pair. accessKeyId is the token id; secretAccessKey is
// SHA-256(token value) with no trailing newline (cf.sha256Hex enforces it, the
// #154 finding). Minting is not idempotent (each call makes a new token), so a
// re-provision reuses the registry's stored id or rotates deliberately.
export async function mintScopedR2Token(ctx, { name, bucket }) {
  // Idempotent by NAME (#182 hardening, grok residual 4). A retry after a
  // created-but-uncommitted mint would otherwise leave a zombie token not in the
  // registry. If a token with this name already exists, ROLL its value (same id,
  // no zombie) and reuse it; else create one. The secret value is returned only
  // by the create or the roll, so a roll is how we recover a usable value.
  const existingId = await findTokenIdByName(ctx, name);
  if (existingId) {
    const roll = await cfFetch(ctx.token, 'PUT', `/accounts/${ctx.acct}/tokens/${existingId}/value`,
      { fetchImpl: ctx.fetchImpl });
    const value = roll.result && (typeof roll.result === 'string' ? roll.result : roll.result.value);
    if (!roll.ok || !value) throw opError('mintScopedR2Token roll', name, roll);
    return { tokenId: existingId, accessKeyId: existingId, secretAccessKey: await sha256Hex(value) };
  }
  const body = {
    name,
    policies: [{
      effect: 'allow',
      permission_groups: [{ id: R2_ITEM_READ }, { id: R2_ITEM_WRITE }],
      resources: { [r2BucketResource(ctx.acct, bucket)]: '*' },
    }],
  };
  const r = await cfFetch(ctx.token, 'POST', `/accounts/${ctx.acct}/tokens`,
    { body, fetchImpl: ctx.fetchImpl });
  if (!r.ok || !r.result || !r.result.value) throw opError('mintScopedR2Token', name, r);
  return {
    tokenId: r.result.id,
    accessKeyId: r.result.id,
    secretAccessKey: await sha256Hex(r.result.value),
  };
}

// List account tokens and find one by EXACT name; null if none, or if listing is
// not permitted (the caller then falls through to create, no worse than before).
async function findTokenIdByName(ctx, name) {
  const r = await cfFetch(ctx.token, 'GET', `/accounts/${ctx.acct}/tokens`, { fetchImpl: ctx.fetchImpl });
  if (!r.ok) return null;
  const list = Array.isArray(r.result) ? r.result : [];
  const found = list.find((t) => t && t.name === name);
  return found ? found.id : null;
}

// Does a script already exist? (#182 hardening, grok residual 2.) 200 = present,
// 404 = absent. Used to REFUSE a deploy that would clobber a script NOT in our
// registry: idempotency protects a hostname already in the KV map, but a name can
// still collide with a foreign namespace script (site-<name>) or a foreign
// standalone Worker (/workers/scripts/c1-<name>). Conservative: a 200 is "exists"
// and any non-404 non-200 throws, so we never clobber on uncertainty.
export async function scriptExists(ctx, { name, ns }) {
  const path = ns
    ? `/accounts/${ctx.acct}/workers/dispatch/namespaces/${ns}/scripts/${name}`
    : `/accounts/${ctx.acct}/workers/scripts/${name}`;
  const r = await cfFetch(ctx.token, 'GET', path, { fetchImpl: ctx.fetchImpl });
  if (r.status === 404) return false;
  // A dispatch-namespace GET returns 200 with result.script === null for a
  // script that does NOT exist (a "ghost", #158). Treat that as absent, or every
  // fresh name false-positives the anti-clobber and no site can be provisioned.
  if (r.ok) {
    if (ns && r.result && r.result.script === null) return false;
    return true;
  }
  throw opError('scriptExists', name, r);
}

// 3. A Worker secret. Namespace script when ns is set, else a standalone Worker.
// PUT replaces, so it is idempotent.
export async function putSecret(ctx, { script, ns, name, text }) {
  const base = ns
    ? `/accounts/${ctx.acct}/workers/dispatch/namespaces/${ns}/scripts/${script}`
    : `/accounts/${ctx.acct}/workers/scripts/${script}`;
  const r = await cfFetch(ctx.token, 'PUT', `${base}/secrets`,
    { body: { name, text, type: 'secret_text' }, fetchImpl: ctx.fetchImpl });
  if (!r.ok) throw opError('putSecret', name, r);
  return { name };
}

// 4. The KV site-map entry (hostname -> { script, kind, ... }). The value is
// sent verbatim as the KV value (not JSON-wrapped by the API); PUT replaces, so
// it is idempotent.
export async function writeKVMapEntry(ctx, { kvId, key, value }) {
  const r = await cfFetch(ctx.token, 'PUT',
    `/accounts/${ctx.acct}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(key)}`,
    { body: JSON.stringify(value), headers: { 'content-type': 'text/plain' }, fetchImpl: ctx.fetchImpl });
  if (!r.ok) throw opError('writeKVMapEntry', key, r);
  return { key };
}

// 5. wp / b-dosql: upload the user Worker into the dispatch namespace. The
// b-dosql code is in the uploaded bundle (modules), so there is NO build. PUT
// replaces the script, so it is idempotent.
export async function deployNamespaceScript(ctx, {
  ns, name, mainModule, modules, bindings = [], compatibilityDate, compatibilityFlags = [],
  migrations,
}) {
  const metadata = {
    main_module: mainModule,
    compatibility_date: compatibilityDate,
    compatibility_flags: compatibilityFlags,
    bindings,
  };
  // A SQLite Durable Object class binding is REJECTED (API 10061) unless a
  // migration declares the class. The b-dosql wp site binds PhpRuntime, so the
  // migration is not optional: without it the deploy throws and no site exists
  // (measured live, #158). Only set it when classes are given, so a site with
  // no DO class uploads unchanged.
  if (migrations && migrations.new_sqlite_classes && migrations.new_sqlite_classes.length) {
    metadata.migrations = { new_tag: migrations.new_tag || 'v1', new_sqlite_classes: migrations.new_sqlite_classes };
  }
  const form = buildScriptForm(metadata, modules);
  const r = await cfFetch(ctx.token, 'PUT',
    `/accounts/${ctx.acct}/workers/dispatch/namespaces/${ns}/scripts/${name}`,
    { body: form, fetchImpl: ctx.fetchImpl });
  if (!r.ok) throw opError('deployNamespaceScript', name, r);
  return { name, ns };
}

// Instance resources, keyed by the friendly instance type. The live API stores
// explicit vcpu/memory/disk (instance_type comes back null), so the create
// sends them explicitly. 'basic' is the measured working shape (#154 c1).
export const INSTANCE_RESOURCES = {
  dev: { vcpu: 0.0625, memory_mib: 256, disk_mb: 2000 },
  basic: { vcpu: 0.25, memory_mib: 1024, disk_mb: 4000 },
  'standard-1': { vcpu: 0.5, memory_mib: 4096, disk_mb: 8000 },
  'standard-2': { vcpu: 1, memory_mib: 6144, disk_mb: 12000 },
  'standard-3': { vcpu: 2, memory_mib: 8192, disk_mb: 16000 },
  'standard-4': { vcpu: 4, memory_mib: 12288, disk_mb: 20000 },
};

// Enable the <name>.<subdomain>.workers.dev route for a standalone script. A
// raw script PUT does NOT enable it (unlike `wrangler deploy`), so a shop is
// otherwise deployed but unreachable (#158). Idempotent: already-enabled is ok.
export async function enableWorkersDevSubdomain(ctx, name) {
  const r = await cfFetch(ctx.token, 'POST', `/accounts/${ctx.acct}/workers/scripts/${name}/subdomain`,
    { body: { enabled: true }, fetchImpl: ctx.fetchImpl });
  if (!r.ok) throw opError('enableWorkersDevSubdomain', name, r);
  return { subdomain: name };
}

// 6. shop / c1: deploy a standalone container Worker that REFERENCES an
// already-pushed image by digest. imageRef is a Cloudflare managed-registry
// digest (registry.cloudflare.com/<acct>/<repo>@sha256:<digest>), so there is
// NO Docker build at provision time (the #147/#154 hinge, proven live).
//
// A raw script PUT is NOT enough to run a container: it defines the class but
// does not create the container APPLICATION, so the Worker returns 500 with no
// container (measured live, #158). `wrangler deploy` does the extra step. So
// this op: (1) PUTs the script with the SQLite migration for the container
// class, (2) reads back the class's Durable Object namespace id, (3) creates or
// updates the container application against that namespace with the image and
// instance resources. Idempotent: an existing application is updated (rolling
// the image) rather than recreated.
export async function deployContainerWorkerFromDigest(ctx, {
  name, mainModule, modules, bindings = [], compatibilityDate, compatibilityFlags = [],
  containerClass, imageRef, instanceType = 'basic', migrationTag = 'v1',
  appName, schedulingPolicy = 'default', maxInstances = 1, constraints = { tiers: [1, 2] },
}) {
  if (!/^[^:]+(:[^@]+)?@sha256:[0-9a-f]{64}$/.test(imageRef) && !imageRef.startsWith('registry.cloudflare.com/')) {
    throw new Error(`deployContainerWorkerFromDigest(${name}): imageRef must be a pushed registry digest, got ${imageRef}`);
  }
  const metadata = {
    main_module: mainModule,
    compatibility_date: compatibilityDate,
    compatibility_flags: compatibilityFlags,
    bindings,
    migrations: { new_tag: migrationTag, new_sqlite_classes: [containerClass] },
    // The `containers` metadata is what CONTAINER-ENABLES the DO class. Without
    // it the migration makes a plain SQLite DO and the application create fails
    // with 1607 DURABLE_OBJECT_NOT_CONTAINER_ENABLED (measured live, #158). It
    // is omitted from the public multipart-metadata allowlist but the API
    // accepts it, and `wrangler deploy` sends exactly this (captured from a
    // trace deploy). The application itself is still created below; this only
    // enables the class.
    containers: [{ class_name: containerClass, image: imageRef, instance_type: instanceType, max_instances: maxInstances }],
  };
  const form = buildScriptForm(metadata, modules);
  const put = await cfFetch(ctx.token, 'PUT', `/accounts/${ctx.acct}/workers/scripts/${name}`,
    { body: form, fetchImpl: ctx.fetchImpl });
  if (!put.ok) throw opError('deployContainerWorkerFromDigest', name, put);

  // Resolve the container class's DO namespace id from the deployed script.
  const settings = await cfFetch(ctx.token, 'GET', `/accounts/${ctx.acct}/workers/scripts/${name}/settings`, { fetchImpl: ctx.fetchImpl });
  if (!settings.ok) throw opError('deployContainerWorkerFromDigest settings', name, settings);
  const doBinding = (settings.result.bindings || []).find((b) => b.type === 'durable_object_namespace' && b.class_name === containerClass);
  const namespaceId = doBinding && doBinding.namespace_id;
  if (!namespaceId) throw new Error(`deployContainerWorkerFromDigest(${name}): no DO namespace for class ${containerClass} after deploy (migration did not create it)`);

  // Create or update the container application against that namespace. The
  // body matches what `wrangler deploy` sends (captured from a trace deploy):
  // instances 0, instance_type in the configuration (the API expands it to
  // vcpu/memory/disk), and the tier constraints.
  const application = appName || `${name}-store`;
  const body = {
    name: application, scheduling_policy: schedulingPolicy,
    instances: 0, max_instances: maxInstances,
    durable_objects: { namespace_id: namespaceId },
    configuration: { image: imageRef, instance_type: instanceType },
    constraints,
  };
  const list = await cfFetch(ctx.token, 'GET', `/accounts/${ctx.acct}/containers/applications`, { fetchImpl: ctx.fetchImpl });
  const existing = list.ok && (list.result || []).find((a) => a.name === application);
  let appResp;
  if (existing) {
    appResp = await cfFetch(ctx.token, 'PATCH', `/accounts/${ctx.acct}/containers/applications/${existing.id}`,
      { body: { max_instances: maxInstances, configuration: body.configuration, constraints }, fetchImpl: ctx.fetchImpl });
  } else {
    appResp = await cfFetch(ctx.token, 'POST', `/accounts/${ctx.acct}/containers/applications`,
      { body, fetchImpl: ctx.fetchImpl });
  }
  if (!appResp.ok) throw opError('deployContainerWorkerFromDigest application', application, appResp);

  return { name, imageRef, application, namespaceId, applicationId: (appResp.result && appResp.result.id) || (existing && existing.id) };
}

// Routing: a proxied originless record (AAAA 100::) so a hostname enters the
// SaaS zone and the */* dispatcher runs on it. Idempotent: an already-present
// record (81053/81057) is success. The dispatcher routes by Host through KV, so
// the record carries no origin of its own.
export async function ensureProxiedHostname(ctx, { zoneId, hostname }) {
  const r = await cfFetch(ctx.token, 'POST', `/zones/${zoneId}/dns_records`,
    { body: { type: 'AAAA', name: hostname, content: '100::', proxied: true }, fetchImpl: ctx.fetchImpl });
  if (!r.ok && !r.errors.some((e) => e.code === 81053 || e.code === 81057)) throw opError('ensureProxiedHostname', hostname, r);
  return { routed: hostname, zone: zoneId };
}

// A modules-format script upload body: one JSON metadata part plus each module
// file. Shared by the namespace and standalone deploys.
function buildScriptForm(metadata, modules) {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  for (const m of modules) {
    form.append(m.name, new Blob([m.content], { type: m.type || 'application/javascript+module' }), m.name);
  }
  return form;
}


// 7. Custom hostname (Cloudflare for SaaS): attach an end-user vanity domain to
// the SaaS zone's dispatcher. TWO ownership modes, differing ONLY in who places
// the DNS records. The anti-hostage property is the point: the customer keeps
// their domain and registrar, CNAMEs to us, and can repoint away at any time;
// we never hold their domain.
//   mode 'managed'  : the customer's zone is on an account we control
//                     (custZoneId). The op places the CNAME + DCV record via the
//                     API, hands-off. This is the agency-holds-the-domain case.
//   mode 'delegated': the CUSTOMER holds the domain. The op touches NONE of
//                     their DNS; it returns the exact records for them to add
//                     (the CNAME target + the DCV name/value), then polls.
//   dcvDelegation (delegated): also emit the ONE-TIME _acme-challenge delegation
//                     CNAME, so certificate RENEWALS auto-validate without the
//                     customer re-doing DNS each cycle.
// Returns { id, hostname, mode, dcvDelegation, records, status }. `records` is
// structured so a CLI prints it and a provisioning Worker hands it to a customer
// UI. In managed mode the op has already placed them.
export async function addCustomHostname(ctx, {
  saasZoneId, hostname, fallbackHostname, mode, dcvDelegation = false,
  custZoneId, dcvMethod = 'txt', minTls = '1.2', pollMs = 0, intervalMs = 5000,
}) {
  if (mode !== 'managed' && mode !== 'delegated') throw new Error(`addCustomHostname: unknown mode ${mode}`);
  const create = await cfFetch(ctx.token, 'POST', `/zones/${saasZoneId}/custom_hostnames`,
    { body: { hostname, ssl: { method: dcvMethod, type: 'dv', settings: { min_tls_version: minTls } } }, fetchImpl: ctx.fetchImpl });
  if (!create.ok || !create.result) throw opError('addCustomHostname', hostname, create);
  const ch = create.result;
  const dcv = (ch.ssl && ch.ssl.validation_records && ch.ssl.validation_records[0]) || {};
  const records = [
    { kind: 'cname', name: hostname, value: fallbackHostname, note: 'point the domain at the SaaS zone (grey cloud at the customer)' },
  ];
  if (dcv.txt_name) records.push({ kind: 'txt', name: dcv.txt_name, value: dcv.txt_value, note: 'DCV: proves control for the certificate' });
  if (ch.ownership_verification && ch.ownership_verification.name) {
    records.push({ kind: ch.ownership_verification.type === 'cname' ? 'cname' : 'txt', name: ch.ownership_verification.name, value: ch.ownership_verification.value, note: 'hostname ownership' });
  }
  if (dcvDelegation) {
    const u = await cfFetch(ctx.token, 'GET', `/zones/${saasZoneId}/dcv_delegation/uuid`, { fetchImpl: ctx.fetchImpl });
    const uuid = u.result && u.result.uuid;
    if (uuid) records.push({ kind: 'cname', name: `_acme-challenge.${hostname}`, value: `${hostname}.${uuid}.dcv.cloudflare.com`, note: 'one-time DCV delegation: cert RENEWALS auto-validate, no customer action each cycle' });
  }
  if (mode === 'managed') {
    if (!custZoneId) throw new Error('addCustomHostname(managed): custZoneId (the zone we control for the customer domain) is required');
    for (const r of records) {
      const resp = await cfFetch(ctx.token, 'POST', `/zones/${custZoneId}/dns_records`, { body: dnsRecordBody(r), fetchImpl: ctx.fetchImpl });
      if (!resp.ok && !resp.errors.some((e) => e.code === 81053 || e.code === 81057)) throw opError('addCustomHostname placeRecord', r.name, resp);
    }
  }
  // delegated: place NOTHING on the customer DNS (the anti-hostage guarantee).
  let status = { hostname: ch.status, ssl: ch.ssl && ch.ssl.status, active: ch.status === 'active' && ch.ssl && ch.ssl.status === 'active' };
  if (pollMs > 0) status = await pollCustomHostname(ctx, { saasZoneId, id: ch.id, pollMs, intervalMs });
  return { id: ch.id, hostname, mode, dcvDelegation, records, status };
}

function dnsRecordBody(r) {
  if (r.kind === 'cname') return { type: 'CNAME', name: r.name, content: r.value, proxied: false };
  return { type: 'TXT', name: r.name, content: r.value };
}

async function pollCustomHostname(ctx, { saasZoneId, id, pollMs, intervalMs = 5000 }) {
  const t0 = Date.now();
  for (;;) {
    const r = await cfFetch(ctx.token, 'GET', `/zones/${saasZoneId}/custom_hostnames/${id}`, { fetchImpl: ctx.fetchImpl });
    const st = { hostname: r.result && r.result.status, ssl: r.result && r.result.ssl && r.result.ssl.status };
    st.active = st.hostname === 'active' && st.ssl === 'active';
    if (st.active) return st;
    if (Date.now() - t0 >= pollMs) return { ...st, timedOut: true };
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}


// ---- Demo teardown ops (#182 Path B reaper) ---------------------------------
// Each reverses one resource a demo site created, so the reaper can fully tear a
// demo down. All are idempotent: a 404 (already gone) is success.

// Delete a dispatch-namespace script (the demo Worker).
export async function deleteNamespaceScript(ctx, { ns, name }) {
  const r = await cfFetch(ctx.token, 'DELETE',
    `/accounts/${ctx.acct}/workers/dispatch/namespaces/${ns}/scripts/${name}`, { fetchImpl: ctx.fetchImpl });
  if (r.ok || r.status === 404) return { deleted: name };
  throw opError('deleteNamespaceScript', name, r);
}

// Empty then delete an R2 bucket (R2 refuses to delete a non-empty bucket). The
// drain is a bounded loop so a paging or delete hiccup cannot spin forever.
export async function deleteR2Bucket(ctx, name) {
  for (let i = 0; i < 20; i++) {
    const list = await cfFetch(ctx.token, 'GET',
      `/accounts/${ctx.acct}/r2/buckets/${name}/objects?per_page=1000`, { fetchImpl: ctx.fetchImpl });
    if (list.status === 404) return { deleted: name, existed: false };
    if (!list.ok) throw opError('deleteR2Bucket list', name, list);
    const objs = (list.result && (list.result.objects || (Array.isArray(list.result) ? list.result : []))) || [];
    if (!objs.length) break;
    for (const o of objs) {
      const key = o.key || o.name;
      const d = await cfFetch(ctx.token, 'DELETE',
        `/accounts/${ctx.acct}/r2/buckets/${name}/objects/${encodeURIComponent(key)}`, { fetchImpl: ctx.fetchImpl });
      if (!d.ok && d.status !== 404) throw opError('deleteR2Bucket object', key, d);
    }
  }
  const del = await cfFetch(ctx.token, 'DELETE', `/accounts/${ctx.acct}/r2/buckets/${name}`, { fetchImpl: ctx.fetchImpl });
  if (del.ok || del.status === 404) return { deleted: name };
  throw opError('deleteR2Bucket', name, del);
}

// Delete the proxied originless routing record(s) for a hostname on the SaaS zone.
export async function deleteProxiedHostname(ctx, { zoneId, hostname }) {
  const list = await cfFetch(ctx.token, 'GET',
    `/zones/${zoneId}/dns_records?type=AAAA&name=${encodeURIComponent(hostname)}`, { fetchImpl: ctx.fetchImpl });
  if (list.status === 404) return { deleted: hostname, count: 0 };
  if (!list.ok) throw opError('deleteProxiedHostname list', hostname, list);
  const recs = list.result || [];
  for (const rec of recs) {
    const d = await cfFetch(ctx.token, 'DELETE', `/zones/${zoneId}/dns_records/${rec.id}`, { fetchImpl: ctx.fetchImpl });
    if (!d.ok && d.status !== 404) throw opError('deleteProxiedHostname', hostname, d);
  }
  return { deleted: hostname, count: recs.length };
}

// ---- WordPress install (#215) ------------------------------------------------
// Seed the WP install so a provisioned site is READY (not stuck at
// /wp-admin/install.php). This is a request to the site itself, NOT a Cloudflare
// API call, authorized by the site's own SPIKE_TOKEN secret, so it needs NO new
// token scope.
//
// PRIMARY path: the dispatch-namespace BINDING (env.DISPATCHER.get(scriptName)).
// It routes DIRECTLY to the namespace script the instant it is deployed, bypassing
// public DNS + the KV->dispatcher propagation window (which 530s for ~30-60s right
// after a deploy, the #215 deploy-gate bug). FALLBACK: a public HTTP POST to the
// hostname, for the node CLI (which has no dispatch binding); its retries bridge
// the propagation window.
//
// AUTH: the site's /_install handler checks the `x-spike-token` header against its
// SPIKE_TOKEN secret (spikes/b2-wordpress/index.js), so that is the header sent
// (NOT an Authorization: Bearer, which the handler does not read). The admin
// password (>= 12 chars) seeds the 'admin' user. Idempotent server-side
// (is_blog_installed() -> {installed:'already'}). Response envelope { out, ms }
// where `out` is the install JSON.
async function parseInstallResponse(res) {
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  let inner = null;
  try { inner = body && typeof body.out === 'string' ? JSON.parse(body.out) : null; } catch { inner = null; }
  if (inner && (inner.installed === true || inner.installed === 'already')) {
    return { ok: true, result: { installed: true, already: inner.installed === 'already', userId: inner.user_id } };
  }
  return { ok: false, error: (inner && inner.error) || (body && body.errors) || `HTTP ${res && res.status}` };
}

export async function installWordPress({
  dispatcher, scriptName, hostname, spikeToken, adminPassword,
  retries = 6, intervalMs = 2000, fetchImpl = fetch,
}) {
  if (!spikeToken) throw new Error(`installWordPress(${scriptName || hostname}): no SPIKE_TOKEN to authorize the install`);
  if (!adminPassword || adminPassword.length < 12) throw new Error(`installWordPress(${scriptName || hostname}): admin password must be at least 12 chars`);
  const viaDispatch = Boolean(dispatcher && scriptName && typeof dispatcher.get === 'function');
  if (!viaDispatch && !hostname) throw new Error('installWordPress: need a dispatcher binding (+ scriptName) or a hostname');
  const headers = { 'x-spike-token': spikeToken, 'x-admin-password': adminPassword };
  let last = 'no attempt';
  for (let i = 0; i < retries; i++) {
    try {
      let res;
      if (viaDispatch) {
        // The dispatch binding routes to site-<name> directly (no DNS/KV race).
        res = await dispatcher.get(scriptName).fetch(new Request('https://internal/_install', { method: 'POST', headers }));
      } else {
        res = await fetchImpl(`https://${hostname}/_install`, { method: 'POST', headers });
      }
      const parsed = await parseInstallResponse(res);
      if (parsed.ok) return { ...parsed.result, via: viaDispatch ? 'dispatch' : 'http' };
      last = parsed.error;
    } catch (e) { last = (e && e.message) || String(e); }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`installWordPress(${scriptName || hostname}) failed after ${retries} tries (${viaDispatch ? 'dispatch' : 'http'}): ${last}`);
}

// ---- Approach A (#218): the per-site object-cache L2 KV namespace ------------
// Approach A binds a per-site OC_KV namespace (the object-cache L2, so a cold
// isolate reads KV instead of crossing the Hyperdrive hop to MySQL). Unlike the
// media bucket, a KV namespace id is ASSIGNED by Cloudflare at create time, so it
// cannot be derived from the site name; provisionSite creates it here, then
// injects the returned id into the OC_KV binding. Idempotent by TITLE: a retry
// after a created-but-uncommitted namespace reuses the existing one (found in the
// list) rather than creating a duplicate.
export async function ensureKVNamespace(ctx, title) {
  const r = await cfFetch(ctx.token, 'POST', `/accounts/${ctx.acct}/storage/kv/namespaces`,
    { body: { title }, fetchImpl: ctx.fetchImpl });
  if (r.ok && r.result && r.result.id) return { id: r.result.id, title, created: true };
  // 10014 = a namespace with this title already exists. A 409 is the same case.
  // Find it by title in the list and reuse it (idempotent, no duplicate).
  if (r.status === 409 || r.errors.some((e) => e.code === 10014)) {
    const id = await findKVNamespaceIdByTitle(ctx, title);
    if (id) return { id, title, created: false, existed: true };
  }
  throw opError('ensureKVNamespace', title, r);
}

// List KV namespaces and find one by EXACT title; null if none or if listing is
// not permitted. Paginates (100/page) so a title past the first page is still
// found; bounded so a paging hiccup cannot spin forever.
async function findKVNamespaceIdByTitle(ctx, title) {
  for (let page = 1; page <= 50; page++) {
    const r = await cfFetch(ctx.token, 'GET',
      `/accounts/${ctx.acct}/storage/kv/namespaces?per_page=100&page=${page}`, { fetchImpl: ctx.fetchImpl });
    if (!r.ok) return null;
    const list = Array.isArray(r.result) ? r.result : [];
    const found = list.find((n) => n && n.title === title);
    if (found) return found.id;
    if (list.length < 100) break;
  }
  return null;
}


// createKvNamespace: the descriptor-table resourceCreateOp name for a KV
// namespace create (#201 Phase 1). ensureKVNamespace already implements the
// idempotent-by-title create (approach A's OC_KV uses it), so this is an ALIAS,
// not a second implementation: the next wave's b-dosql L2 KV descriptor reaches
// the op by a stable name and both callers share one source (no drift).
export const createKvNamespace = ensureKVNamespace;

// createQueue: a Cloudflare Queue for the next wave's durable async-email
// descriptor (#190). Idempotent by NAME: a create conflict (409, or an
// "already exists" error) means a prior provision made it, so find it by name and
// reuse it rather than fail the provision. Pure fetch on cf.mjs, callable from
// node or a Worker, matching createR2Bucket / ensureKVNamespace.
export async function createQueue(ctx, name) {
  const r = await cfFetch(ctx.token, 'POST', `/accounts/${ctx.acct}/queues`,
    { body: { queue_name: name }, fetchImpl: ctx.fetchImpl });
  const idOf = (res) => res && (res.queue_id || res.id);
  if (r.ok && idOf(r.result)) return { id: idOf(r.result), name, created: true };
  if (r.status === 409 || r.errors.some((e) => e.code === 10019 || /exist/i.test(e.message || ''))) {
    const id = await findQueueIdByName(ctx, name);
    if (id) return { id, name, created: false, existed: true };
  }
  throw opError('createQueue', name, r);
}

// List queues and find one by EXACT name; null if none or if listing is not
// permitted. Paginates (100/page), bounded so a paging hiccup cannot spin forever.
async function findQueueIdByName(ctx, name) {
  for (let page = 1; page <= 50; page++) {
    const r = await cfFetch(ctx.token, 'GET',
      `/accounts/${ctx.acct}/queues?per_page=100&page=${page}`, { fetchImpl: ctx.fetchImpl });
    if (!r.ok) return null;
    const list = Array.isArray(r.result) ? r.result : [];
    const found = list.find((q) => q && q.queue_name === name);
    if (found) return found.queue_id || found.id;
    if (list.length < 100) break;
  }
  return null;
}


// Read one custom hostname's live status from the SaaS zone (Cloudflare for
// SaaS). Returns { hostname, ssl, active }: active is true only when both the
// hostname and its certificate are active. Used by `site hostname status` to
// poll a delegated domain the customer is still wiring up, without placing any
// DNS (the anti-hostage guarantee). A single GET, no retry; the CLI loops it.
export async function getCustomHostnameStatus(ctx, { saasZoneId, id }) {
  const r = await cfFetch(ctx.token, 'GET',
    `/zones/${saasZoneId}/custom_hostnames/${id}`, { fetchImpl: ctx.fetchImpl });
  if (!r.ok || !r.result) throw opError('getCustomHostnameStatus', id, r);
  const hostname = r.result.status;
  const ssl = r.result.ssl && r.result.ssl.status;
  return { hostname, ssl, active: hostname === 'active' && ssl === 'active' };
}
