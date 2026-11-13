// Make the dispatch namespace the site manager binds, if it is missing (issue #416).
// The Deploy to Cloudflare button runs this before `wrangler deploy` (package.json
// "deploy"), because the button's own list of resources it makes has no dispatch
// namespace (https://developers.cloudflare.com/workers/platform/deploy-buttons/, read
// 2026-11-13). Cloudflare's Worker Publisher template does the same step.
//
// It reads the token and account from the build environment (CLOUDFLARE_API_TOKEN,
// CLOUDFLARE_ACCOUNT_ID), and the namespace name from wrangler.toml, so a renamed
// namespace stays in step. Idempotent: an existing namespace is success.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';

export function namespaceFromToml(toml) {
  const block = toml.split(/\n(?=\[)/).find((b) => /^\[\[dispatch_namespaces\]\]/.test(b.trim()));
  const m = block && block.match(/^\s*namespace\s*=\s*"([a-z0-9-]{1,63})"\s*$/m);
  if (!m) throw new Error('wrangler.toml has no [[dispatch_namespaces]] namespace = "<name>"');
  return m[1];
}

async function call(fetchImpl, token, method, path, body) {
  const res = await fetchImpl(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, ok: res.ok, json };
}
const why = (r) => ((r.json && r.json.errors) || []).map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${r.status}`;

export async function ensureNamespace({ token, account, name, fetchImpl = fetch }) {
  if (!token) throw new Error('CLOUDFLARE_API_TOKEN is not set');
  let acct = account;
  if (!acct) {
    const r = await call(fetchImpl, token, 'GET', '/accounts?per_page=5');
    const list = (r.ok && r.json && Array.isArray(r.json.result)) ? r.json.result : [];
    if (list.length !== 1) throw new Error(`cannot tell which account to use (${r.ok ? `${list.length} accounts` : why(r)}); set CLOUDFLARE_ACCOUNT_ID`);
    acct = list[0].id;
  }
  const got = await call(fetchImpl, token, 'GET', `/accounts/${acct}/workers/dispatch/namespaces/${name}`);
  if (got.ok) return { name, created: false };
  if (got.status !== 404) throw new Error(`could not read the dispatch namespace ${name}: ${why(got)}. Is Workers for Platforms turned on for this account?`);
  const made = await call(fetchImpl, token, 'POST', `/accounts/${acct}/workers/dispatch/namespaces`, { name });
  if (!made.ok) throw new Error(`could not make the dispatch namespace ${name}: ${why(made)}. Turn on Workers for Platforms for this account first.`);
  return { name, created: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const toml = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const r = await ensureNamespace({ token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID, name: namespaceFromToml(toml) });
    console.log(`dispatch namespace ${r.name}: ${r.created ? 'made' : 'already there'}`);
  } catch (e) {
    console.error(`ensure-namespace: ${e.message}`);
    process.exit(1);
  }
}
