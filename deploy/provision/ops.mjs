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
}) {
  const metadata = {
    main_module: mainModule,
    compatibility_date: compatibilityDate,
    compatibility_flags: compatibilityFlags,
    bindings,
  };
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
