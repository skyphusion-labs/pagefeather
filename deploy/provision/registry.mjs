// Provisioning core, the site registry (#154). The registry IS the KV site map:
// each site is one entry, keyed by its hostname, whose value carries the
// dispatcher fields PLUS kind ('wp' | 'shop') and the per-site resources the
// provisioner created (buckets, the token id). Extending the existing
// wp-wfp-sites map is the light option from #154; a separate store is the
// alternative if the map grows noisy. All helpers are callable from the CLI or
// a provisioning Worker through the same ctx { acct, token, fetchImpl? }.
import { cfFetch, opError } from './cf.mjs';
import { writeKVMapEntry } from './ops.mjs';

// Record (or replace) a site. entry = { script, kind, outbound?, cpuMs?,
// subRequests?, resources?, build? }. Idempotent (PUT replaces).
export async function upsertSite(ctx, { kvId, hostname, entry }) {
  await writeKVMapEntry(ctx, { kvId, key: hostname, value: entry });
  return { hostname };
}

// Read one site's entry, or null when absent.
export async function readSite(ctx, { kvId, hostname }) {
  const r = await cfFetch(ctx.token, 'GET',
    `/accounts/${ctx.acct}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(hostname)}`,
    { fetchImpl: ctx.fetchImpl });
  if (r.status === 404) return null;
  if (!r.ok) throw opError('readSite', hostname, r);
  try { return JSON.parse(r.raw); } catch { return null; }
}

// List the hostnames in the map (optionally by prefix).
export async function listSites(ctx, { kvId, prefix } = {}) {
  const q = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
  const r = await cfFetch(ctx.token, 'GET',
    `/accounts/${ctx.acct}/storage/kv/namespaces/${kvId}/keys${q}`, { fetchImpl: ctx.fetchImpl });
  if (!r.ok) throw opError('listSites', prefix || '*', r);
  return (r.result || []).map((k) => k.name);
}

// Remove a site's entry (idempotent: a missing key is success).
export async function removeSite(ctx, { kvId, hostname }) {
  const r = await cfFetch(ctx.token, 'DELETE',
    `/accounts/${ctx.acct}/storage/kv/namespaces/${kvId}/values/${encodeURIComponent(hostname)}`,
    { fetchImpl: ctx.fetchImpl });
  if (!r.ok && r.status !== 404) throw opError('removeSite', hostname, r);
  return { hostname, removed: true };
}
