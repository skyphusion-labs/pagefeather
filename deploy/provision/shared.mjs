// Provisioning core, the shared validators and secret generator (#182). ONE
// source for the three things the CLI, the orchestration and the provisioning
// Worker all need to agree on: what a valid site name is, which names are
// RESERVED, and how a per-site secret is generated. Before #182 the name regex
// lived only in cli.mjs, so the Worker path (worker.mjs) could provision a site
// the CLI would have rejected. A single canonical copy removes that drift. Pure
// Web Crypto, so the IDENTICAL module runs in node and inside a Worker.

// A site name: lower case, digits, hyphens, 1 to 30 chars, no leading or
// trailing hyphen. The script name (site-<name> / c1-<name>), the bucket names
// and the hostname label are all derived from it, so it is also the untrusted
// input that reaches a URL path and a resource id. Keep this literal identical
// to any copy; it is the allowlist that bounds all of them.
export const SITE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$/;

// Reserved names (#182 hardening, grok residual 2). SITE_NAME_RE is a CHARSET
// allowlist, not a reservation check: without this, name=www passes and the wp
// path writes a proxied record for www.<base> + a dispatcher KV key, or the
// shop path PUTs /workers/scripts/c1-www. These are infrastructure and common
// service labels that must never be mintable as a tenant site. Lower case, matched
// case-insensitively; a name is reserved if it equals one of these OR starts with
// one of the structural prefixes this project uses for its own scripts/buckets.
export const RESERVED_NAMES = new Set([
  'www', 'mail', 'email', 'smtp', 'imap', 'pop', 'pop3', 'mx', 'webmail',
  'ns', 'ns1', 'ns2', 'dns', 'api', 'admin', 'administrator', 'root', 'sudo',
  'ftp', 'sftp', 'ssh', 'vpn', 'proxy', 'gateway', 'cdn', 'autodiscover',
  'autoconfig', 'cpanel', 'whm', 'localhost', 'internal', 'dispatch',
  'dispatcher', 'outbound', 'wp', 'wfp', 'woo', 'shop', 'site', 'c1',
  'studio', 'demo', 'staging', 'prod', 'production', 'test', 'default',
]);
// Structural prefixes: a name beginning with one of these would collide with the
// project's own derived script or bucket names (site-<s>, c1-<s>, wp-wfp-<s>-media).
export const RESERVED_PREFIXES = ['site-', 'c1-', 'wp-wfp-', 'wp-woo-'];

export function isReservedName(name) {
  if (typeof name !== 'string') return false;
  const n = name.toLowerCase();
  if (RESERVED_NAMES.has(n)) return true;
  return RESERVED_PREFIXES.some((p) => n.startsWith(p));
}

// Throw unless name passes SITE_NAME_RE AND is not reserved. Used server-side in
// provisionSite so the Worker (not only the CLI) rejects a bad or reserved name
// before any op runs.
export function assertValidName(name) {
  if (typeof name !== 'string' || !SITE_NAME_RE.test(name)) {
    throw new Error(`invalid site name: ${JSON.stringify(name)} (lower case, digits, hyphens, 1 to 30, no leading or trailing hyphen)`);
  }
  if (isReservedName(name)) {
    throw new Error(`reserved site name: ${JSON.stringify(name)} (an infrastructure or service label; pick another)`);
  }
  return name;
}

// A per-site secret: hex of random bytes (Web Crypto, Worker and node).
export function genSecret(bytes = 32) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}


// ---- Public demo lane (#182 Path B) -----------------------------------------
// Tunable caps for the public demo front door. The lead sets finals at deploy;
// these are the sane defaults. A demo is ephemeral (TTL), its name is assigned
// by the worker (never the caller), and both a per-IP/global rate limit and a
// hard concurrency ceiling bound abuse and account spend.
export const DEMO_TTL_MS = 3 * 60 * 60 * 1000;      // 3 hours
export const DEMO_MAX_PER_IP_PER_HOUR = 3;          // per-IP rate
export const DEMO_MAX_GLOBAL_PER_HOUR = 60;         // global rate
export const DEMO_MAX_CONCURRENT = 20;              // live demos ceiling (primary spend bound)
export const DEMO_NAME_PREFIX = 'demo-';            // the dedicated demo lane

// A worker-assigned demo site name: demo-<16 hex>. The PUBLIC caller never
// chooses this (kills name-squatting + tenant impersonation at the source). The
// result passes SITE_NAME_RE and is not reserved (the reserved set has the bare
// word 'demo', not the 'demo-<rand>' lane). Length is 5 + 16 = 21, within 30.
export function assignDemoName() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  const rand = Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${DEMO_NAME_PREFIX}${rand}`;
}

// Is this a demo-lane name? Used by the reaper and the concurrency count.
export function isDemoName(name) {
  return typeof name === 'string' && name.startsWith(DEMO_NAME_PREFIX);
}