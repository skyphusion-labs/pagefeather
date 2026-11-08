// Provisioning core, the shared validators and secret generator (#182). ONE
// source for the two things the CLI, the orchestration and the provisioning
// Worker all need to agree on: what a valid site name is, and how a per-site
// secret is generated. Before #182 the name regex lived only in cli.mjs, so the
// Worker path (worker.mjs) could provision a site the CLI would have rejected.
// A single canonical copy removes that drift. Pure Web Crypto, so the IDENTICAL
// module runs in node and inside a Worker.

// A site name: lower case, digits, hyphens, 1 to 30 chars, no leading or
// trailing hyphen. The script name (site-<name> / c1-<name>), the bucket names
// and the hostname label are all derived from it, so it is also the untrusted
// input that reaches a URL path and a resource id. Keep this literal identical
// to any copy; it is the allowlist that bounds all of them.
export const SITE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$/;

// Throw unless name passes SITE_NAME_RE. Used server-side in provisionSite so
// the Worker (not only the CLI) rejects a bad name before any op runs.
export function assertValidName(name) {
  if (typeof name !== 'string' || !SITE_NAME_RE.test(name)) {
    throw new Error(`invalid site name: ${JSON.stringify(name)} (lower case, digits, hyphens, 1 to 30, no leading or trailing hyphen)`);
  }
  return name;
}

// A per-site secret: hex of random bytes (Web Crypto, Worker and node).
export function genSecret(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
