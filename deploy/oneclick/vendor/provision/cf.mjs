// Provisioning core, Cloudflare API layer (#154). Pure fetch + Web Crypto, so
// the SAME module runs inside a Worker and in node (the CLI). No dependencies,
// no build step. Every caller passes a ctx { acct, token, fetchImpl? }.

export const CF_API = 'https://api.cloudflare.com/client/v4';

// "Workers R2 Storage Bucket Item" permission groups, read and write. These are
// the ids applied in deploy/terraform/c1.tf and deploy/wfp/terraform/site/main.tf
// for the Litestream token; a per-store token uses exactly these two, scoped to
// one bucket. If a mint ever rejects an id, read GET /accounts/{acct}/tokens/
// permission_groups and re-match the two names.
export const R2_ITEM_READ = '6a018a9f2fc74eb6b293b0c548f38b39';
export const R2_ITEM_WRITE = '2efd5506f9c8494dacb1fa10a3e7d5b6';

// One bucket's resource scope for an account token, and the account R2 S3 endpoint.
export const r2BucketResource = (acct, bucket) => `com.cloudflare.edge.r2.bucket.${acct}_default_${bucket}`;
export const r2Endpoint = (acct) => `https://${acct}.r2.cloudflarestorage.com`;

// SHA-256 hex of the EXACT string, with NO trailing newline. This is the #154
// fresh-store finding baked in: an R2 S3 secret derived as SHA-256(value + "\n")
// 403s on the container's first Litestream op, and set -e kills the container
// on boot before it writes anything. TextEncoder encodes s verbatim; this
// function never appends a newline, so a caller cannot reintroduce the bug.
export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

// One Cloudflare API call. Returns { status, ok, result, errors, json, raw }.
// fetchImpl is injected so tests stub it; it defaults to the global fetch, which
// exists in a Worker and in node 22+. A string body is sent verbatim (the caller
// pre-encoded it, e.g. a KV value); a FormData body is sent as-is (multipart
// script upload); any other object body is JSON-encoded.
export async function cfFetch(token, method, path, { body, headers, fetchImpl = fetch } = {}) {
  const h = { authorization: `Bearer ${token}`, ...(headers || {}) };
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  let payload;
  if (isForm) {
    payload = body;
  } else if (typeof body === 'string') {
    payload = body;
  } else if (body !== undefined) {
    if (!h['content-type']) h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetchImpl(`${CF_API}${path}`, { method, headers: h, body: payload });
  const raw = await r.text();
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; } catch { /* non-JSON response */ }
  return {
    status: r.status,
    ok: r.ok,
    result: json ? json.result : null,
    errors: (json && json.errors) || [],
    json,
    raw,
  };
}

// A uniform error that carries the CF error codes, so a caller can branch on them.
export function opError(op, subject, r) {
  const detail = r.errors && r.errors.length
    ? r.errors.map((e) => `${e.code} ${e.message}`).join('; ')
    : `HTTP ${r.status}`;
  const e = new Error(`${op}(${subject}) failed: ${detail}`);
  e.status = r.status;
  e.errors = r.errors;
  return e;
}
