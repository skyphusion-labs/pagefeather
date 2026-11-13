// Deploy-time steps for OUR live site manager (issue #419). Run by
// .github/workflows/deploy-oneclick.yml only; never by an owner's button.
// Pure fetch against the Cloudflare API, with an injectable fetchImpl for tests.
//
//   node live.mjs prepare   the dispatch namespace and the R2 bucket exist (made if missing)
//   node live.mjs url       print the Worker's workers.dev URL
//   node live.mjs access    the Access application for the Worker exists and allows only ADMIN_EMAIL
//   node live.mjs stranger  an unauthenticated request does NOT reach the Worker
//
// Env: CF_TOKEN (the deploy token), CLOUDFLARE_ACCOUNT_ID, ADMIN_EMAIL, and
// ONECLICK_DIR (default deploy/oneclick) for wrangler.toml.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const API = 'https://api.cloudflare.com/client/v4';

export function readConfig(toml) {
  const top = toml.split(/\n\[/)[0];
  const name = (top.match(/^name\s*=\s*"([a-z0-9-]{1,63})"\s*$/m) || [])[1];
  const ns = ((toml.split(/\n(?=\[)/).find((b) => /^\[\[dispatch_namespaces\]\]/.test(b.trim())) || '').match(/^\s*namespace\s*=\s*"([a-z0-9-]{1,63})"\s*$/m) || [])[1];
  const bucket = ((toml.split(/\n(?=\[)/).find((b) => /^\[\[r2_buckets\]\]/.test(b.trim())) || '').match(/^\s*bucket_name\s*=\s*"([a-z0-9-]{3,63})"\s*$/m) || [])[1];
  if (!name || !ns || !bucket) throw new Error(`wrangler.toml: need name, a dispatch namespace and an R2 bucket (got ${name}, ${ns}, ${bucket})`);
  return { name, namespace: ns, bucket };
}

export function client({ token, account, fetchImpl = fetch }) {
  if (!token) throw new Error('CF_TOKEN is not set');
  if (!/^[0-9a-f]{32}$/.test(account || '')) throw new Error('CLOUDFLARE_ACCOUNT_ID is not a 32-hex account id');
  const call = async (method, path, body) => {
    const res = await fetchImpl(`${API}/accounts/${account}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, ok: res.ok && !(json && json.success === false), json, result: json && json.result };
  };
  return { call, account };
}
const why = (r) => ((r.json && r.json.errors) || []).map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${r.status}`;

export async function prepare(c, { namespace, bucket }) {
  const out = {};
  const ns = await c.call('GET', `/workers/dispatch/namespaces/${namespace}`);
  if (ns.ok) out.namespace = 'there';
  else if (ns.status === 404) {
    const made = await c.call('POST', '/workers/dispatch/namespaces', { name: namespace });
    if (!made.ok) throw new Error(`make dispatch namespace ${namespace}: ${why(made)}`);
    out.namespace = 'made';
  } else throw new Error(`read dispatch namespace ${namespace}: ${why(ns)}`);
  const b = await c.call('GET', `/r2/buckets/${bucket}`);
  if (b.ok) out.bucket = 'there';
  else if (b.status === 404) {
    const made = await c.call('POST', '/r2/buckets', { name: bucket });
    if (!made.ok) throw new Error(`make R2 bucket ${bucket}: ${why(made)}`);
    out.bucket = 'made';
  } else throw new Error(`read R2 bucket ${bucket}: ${why(b)}`);
  return out;
}

export async function workerUrl(c, name) {
  const r = await c.call('GET', '/workers/subdomain');
  const sub = r.ok && r.result && r.result.subdomain;
  if (!sub) throw new Error(`read the workers.dev subdomain: ${why(r)}`);
  return `https://${name}.${sub}.workers.dev`;
}

// The Worker's id, for the Access destination. The Access API says "The ID of the
// Cloudflare Worker to protect". It is read from the Workers API; which field is the
// right one is UNMEASURED, so the stranger check after this is what proves it.
export async function workerId(c, name) {
  const w = await c.call('GET', `/workers/workers/${name}`);
  if (w.ok && w.result && /^[0-9a-f]{32}$/.test(w.result.id || '')) return { id: w.result.id, via: 'workers/workers' };
  const s = await c.call('GET', '/workers/scripts');
  const hit = s.ok && Array.isArray(s.result) ? s.result.find((x) => x.id === name) : null;
  if (hit && /^[0-9a-f]{32}$/.test(hit.tag || '')) return { id: hit.tag, via: 'workers/scripts tag' };
  throw new Error(`no id for Worker ${name} (${why(w)}; ${why(s)})`);
}

const isWorkerDest = (d, id) => d && d.type === 'worker' && d.worker_id === id;
export function policyAllowsOnly(app, email) {
  const want = email.toLowerCase();
  const pols = Array.isArray(app.policies) ? app.policies : [];
  if (!pols.length) return { ok: false, reason: 'the application has no policy' };
  for (const p of pols) {
    if (p.decision !== 'allow') return { ok: false, reason: `a policy with decision ${p.decision}` };
    const inc = Array.isArray(p.include) ? p.include : [];
    if (inc.length !== 1 || !inc[0].email || String(inc[0].email.email || '').toLowerCase() !== want) {
      return { ok: false, reason: `a policy whose include is not exactly the email ${email}: ${JSON.stringify(inc)}` };
    }
    if ((p.require && p.require.length) || (p.exclude && p.exclude.length)) return { ok: false, reason: 'a policy with require or exclude rules this workflow does not manage' };
  }
  return { ok: true };
}

export async function ensureAccess(c, { name, email }) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) throw new Error('ADMIN_EMAIL is not an email address');
  const { id, via } = await workerId(c, name);
  const apps = [];
  for (let page = 1; page <= 20; page++) {
    const r = await c.call('GET', `/access/apps?per_page=100&page=${page}`);
    if (!r.ok) throw new Error(`list Access applications: ${why(r)}`);
    const list = Array.isArray(r.result) ? r.result : [];
    apps.push(...list);
    if (list.length < 100) break;
  }
  const mine = apps.filter((a) => Array.isArray(a.destinations) && a.destinations.some((d) => isWorkerDest(d, id)));
  if (mine.length > 1) throw new Error(`${mine.length} Access applications protect Worker ${name}; expected one`);
  if (mine.length === 1) {
    const v = policyAllowsOnly(mine[0], email);
    if (!v.ok) throw new Error(`the Access application ${mine[0].id} for ${name} does not allow only ${email}: ${v.reason}. Fix it by hand or delete it; this workflow does not overwrite it.`);
    return { app: mine[0].id, created: false, workerId: id, via };
  }
  const made = await c.call('POST', '/access/apps', {
    type: 'self_hosted',
    name: `Pagefeather site manager (${name})`,
    destinations: [{ type: 'worker', worker_id: id }],
    session_duration: '24h',
    policies: [{ name: 'owner only', decision: 'allow', include: [{ email: { email } }] }],
  });
  if (!made.ok || !made.result) throw new Error(`create the Access application: ${why(made)}`);
  const v = policyAllowsOnly(made.result, email);
  if (!v.ok) throw new Error(`the created Access application does not read back as owner-only: ${v.reason}`);
  return { app: made.result.id, created: true, workerId: id, via };
}

// The stranger check. The site manager answers 403 itself with no identity, so a
// 403 cannot tell Access-in-front from Access-missing. A pass needs EVERY probe
// to be an Access login redirect (a location on *.cloudflareaccess.com).
// /admin.css is served by the Worker to anyone: a 200 there means Access is missing.
export function classify({ status, location, body }) {
  if ([301, 302, 303, 307, 308].includes(status) && location) {
    let host = '';
    try { host = new URL(location).hostname; } catch { host = ''; }
    if (host.endsWith('.cloudflareaccess.com')) return { pass: true, why: `redirect to ${host}` };
    return { pass: false, why: `redirect to ${host || location}, not to Access` };
  }
  if (status === 200) return { pass: false, why: 'the Worker answered 200: Access is not in front' };
  if (status === 403 && /Sign in required/.test(body || '')) return { pass: false, why: 'the Worker itself refused (its own 403 page): Access is not in front' };
  return { pass: false, why: `status ${status} is not an Access login redirect` };
}

export async function strangerCheck(url, { fetchImpl = fetch, tries = 12, waitMs = 10000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const paths = ['/admin.css', '/', '/api/sites'];
  let last = [];
  for (let t = 1; t <= tries; t++) {
    last = [];
    for (const p of paths) {
      const res = await fetchImpl(url + p, { method: 'GET', redirect: 'manual', headers: { 'user-agent': 'pagefeather-stranger-check/1' } });
      const body = res.status === 200 || res.status === 403 ? await res.text() : '';
      last.push({ path: p, status: res.status, ...classify({ status: res.status, location: res.headers.get('location'), body }) });
    }
    if (last.every((x) => x.pass)) return { pass: true, tries: t, results: last };
    if (t < tries) await sleep(waitMs);
  }
  return { pass: false, tries, results: last };
}

async function main(cmd) {
  const dir = process.env.ONECLICK_DIR || 'deploy/oneclick';
  const cfg = readConfig(await readFile(join(dir, 'wrangler.toml'), 'utf8'));
  const c = client({ token: process.env.CF_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID });
  if (cmd === 'prepare') return console.log(JSON.stringify(await prepare(c, cfg)));
  if (cmd === 'url') return console.log(await workerUrl(c, cfg.name));
  if (cmd === 'access') return console.log(JSON.stringify(await ensureAccess(c, { name: cfg.name, email: process.env.ADMIN_EMAIL })));
  if (cmd === 'stranger') {
    const r = await strangerCheck(await workerUrl(c, cfg.name));
    for (const x of r.results) console.log(`${x.pass ? 'ok  ' : 'FAIL'} GET ${x.path}: ${x.status}, ${x.why}`);
    if (!r.pass) throw new Error(`a stranger reached the Worker (after ${r.tries} tries)`);
    return console.log(`stranger check: every probe went to the Access login (try ${r.tries})`);
  }
  throw new Error('usage: live.mjs prepare | url | access | stranger');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((e) => { console.error(`live: ${e.message}`); process.exit(1); });
}
