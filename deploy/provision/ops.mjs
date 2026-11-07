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

// 6. shop / c1: deploy a standalone container Worker that REFERENCES an
// already-pushed image by digest. imageRef is a Cloudflare managed-registry
// digest (registry.cloudflare.com/<acct>/<repo>@sha256:<digest>), so there is
// NO Docker build at provision time (the #147/#154 hinge, proven live). PUT
// replaces the script; changing the image rolls the container application.
// The exact container-metadata shape is confirmed against the live API in
// validation; the image field carrying a digest ref is the load-bearing part.
export async function deployContainerWorkerFromDigest(ctx, {
  name, mainModule, modules, bindings = [], compatibilityDate, compatibilityFlags = [],
  containerClass, imageRef, instanceType = 'basic', migrationTag = 'v1',
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
    containers: [{ class_name: containerClass, image: imageRef, instance_type: instanceType }],
  };
  const form = buildScriptForm(metadata, modules);
  const r = await cfFetch(ctx.token, 'PUT', `/accounts/${ctx.acct}/workers/scripts/${name}`,
    { body: form, fetchImpl: ctx.fetchImpl });
  if (!r.ok) throw opError('deployContainerWorkerFromDigest', name, r);
  return { name, imageRef };
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
