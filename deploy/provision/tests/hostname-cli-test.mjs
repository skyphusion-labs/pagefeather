// Offline test of the `site hostname` CLI (#248): the pure arg parse plus the
// command wiring, with a stubbed fetchImpl (a KV-backed registry) routed by URL.
// Asserts: delegated writes NOTHING to the customer DNS and hands back the
// records (anti-hostage), managed places them on the zone we control, the owner
// + hostname + state land in the site's registry entry (merged, not clobbered),
// DCV delegation emits the one-time renewal CNAME, and `status` polls the live
// state and persists it. No network, no real creds.
import { parseArgs, parseHostnameArgs, hostnameCommand, DOMAIN_RE, siteHostname, stateOf } from '../cli.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const resp = (body) => ({ ok: true, status: 200, text: async () => body });
const notFound = () => ({ ok: false, status: 404, text: async () => '' });

const SAAS = 'saaszone', CUST = 'custzone';
const ENV = { WFP_KV_ID: 'KV', WFP_SAAS_ZONE_ID: SAAS, WFP_SAAS_FALLBACK: 'fallback.skyphusionwp.dev', WFP_SUBDOMAIN: 'sub' };

// A stub routed by URL. kv is a real map so readSite/updateSite round-trip.
function makeStub({ activeOnCall = 1, seed } = {}) {
  const calls = [];
  const kv = new Map();
  if (seed) kv.set(seed.key, JSON.stringify(seed.value));
  let getN = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const kvMatch = url.match(/\/storage\/kv\/namespaces\/[^/]+\/values\/(.+)$/);
    if (kvMatch) {
      const key = decodeURIComponent(kvMatch[1]);
      if (init.method === 'GET') return kv.has(key) ? resp(kv.get(key)) : notFound();
      if (init.method === 'PUT') { kv.set(key, init.body); return resp('{"success":true,"result":{}}'); }
      if (init.method === 'DELETE') { kv.delete(key); return resp('{"success":true,"result":{}}'); }
    }
    if (url.endsWith(`/zones/${SAAS}/custom_hostnames`) && init.method === 'POST') {
      return resp('{"success":true,"result":{"id":"CHID","status":"pending","ssl":{"status":"pending_validation","validation_records":[{"txt_name":"_acme._cf.host","txt_value":"DCVVAL"}]},"ownership_verification":{"type":"txt","name":"_cf-ownership.host","value":"OWNVAL"}}}');
    }
    if (url.includes('/dcv_delegation/uuid')) return resp('{"success":true,"result":{"uuid":"UUID123"}}');
    if (url.includes('/custom_hostnames/CHID') && init.method === 'GET') {
      getN += 1;
      const active = getN >= activeOnCall;
      return resp(`{"success":true,"result":{"id":"CHID","status":"${active ? 'active' : 'pending'}","ssl":{"status":"${active ? 'active' : 'pending_validation'}"}}}`);
    }
    if (url.includes('/dns_records') && init.method === 'POST') return resp('{"success":true,"result":{"id":"rec"}}');
    return resp('{"success":true,"result":{}}');
  };
  return { fetchImpl, calls, kv };
}
const ctxOf = (s) => ({ acct: 'A', token: 'T', fetchImpl: s.fetchImpl });
const custWrites = (calls) => calls.filter((c) => c.url.includes('/dns_records') && c.method === 'POST');
const sink = () => { const lines = []; const fn = (s) => lines.push(String(s)); fn.lines = lines; return fn; };

// ---- pure arg parse ---------------------------------------------------------
ok('parseArgs routes hostname add to parseHostnameArgs', (() => { const a = parseArgs(['hostname', 'add', 'blog', '--domain', 'shop.customer.com', '--mode', 'delegated']); return a.cmd === 'hostname' && a.sub === 'add' && a.name === 'blog' && a.domain === 'shop.customer.com' && a.mode === 'delegated'; })());
ok('hostname status <name> parses', (() => { const a = parseHostnameArgs(['status', 'blog']); return a.sub === 'status' && a.name === 'blog'; })());
ok('hostname add --dcv-delegation is a boolean flag', parseHostnameArgs(['add', 'blog', '--domain', 'a.b.com', '--mode', 'delegated', '--dcv-delegation']).dcvDelegation === true);
ok('hostname add managed parses --cust-zone', (() => { const a = parseHostnameArgs(['add', 'blog', '--domain', 'a.b.com', '--mode', 'managed', '--cust-zone', 'Z']); return a.mode === 'managed' && a.custZone === 'Z'; })());
ok('hostname rejects an unknown sub', throws(() => parseHostnameArgs(['frob', 'blog'])));
ok('hostname add REQUIRES --domain', throws(() => parseHostnameArgs(['add', 'blog', '--mode', 'delegated'])));
ok('hostname add rejects a bad FQDN', throws(() => parseHostnameArgs(['add', 'blog', '--domain', 'not a domain', '--mode', 'delegated'])));
ok('hostname add REQUIRES a valid --mode', throws(() => parseHostnameArgs(['add', 'blog', '--domain', 'a.b.com', '--mode', 'bogus'])));
ok('hostname add managed REQUIRES --cust-zone', throws(() => parseHostnameArgs(['add', 'blog', '--domain', 'a.b.com', '--mode', 'managed'])));
ok('hostname add delegated REJECTS --cust-zone (anti-hostage contradiction)', throws(() => parseHostnameArgs(['add', 'blog', '--domain', 'a.b.com', '--mode', 'delegated', '--cust-zone', 'Z'])));
ok('hostname rejects a bad site name', throws(() => parseHostnameArgs(['status', 'Bad_Name'])));
ok('hostname rejects an unknown flag (a typo fails loudly)', throws(() => parseHostnameArgs(['add', 'blog', '--domain', 'a.b.com', '--mode', 'delegated', '--bogus', 'x'])));
ok('DOMAIN_RE accepts an FQDN and rejects junk', DOMAIN_RE.test('shop.customer.com') && !DOMAIN_RE.test('nodots') && !DOMAIN_RE.test('-bad.com'));
ok('siteHostname uses WP_HOSTNAME when set, else the workers.dev vanity', siteHostname('blog', { WP_HOSTNAME: 'blog.skyphusionwp.dev' }) === 'blog.skyphusionwp.dev' && siteHostname('blog', { WFP_SUBDOMAIN: 'sub' }) === 'wp-blog.sub.workers.dev');
ok('stateOf maps active -> active, else pending', stateOf({ active: true }) === 'active' && stateOf({ active: false }) === 'pending' && stateOf(null) === 'pending');

// ---- delegated add: nothing on the customer DNS, records returned, registry merged
{
  const s = makeStub({ seed: { key: 'wp-blog.sub.workers.dev', value: { script: 'site-blog', kind: 'wp' } } });
  const out = sink(), err = sink();
  const parsed = parseHostnameArgs(['add', 'blog', '--domain', 'shop.customer.com', '--mode', 'delegated']);
  const r = await hostnameCommand(ctxOf(s), parsed, ENV, { out, err });
  ok('delegated: records placed on NO customer DNS (anti-hostage)', custWrites(s.calls).length === 0);
  ok('delegated: domainOwner is customer', r.domainOwner === 'customer');
  ok('delegated: records returned include the CNAME to the SaaS fallback', r.records.some((x) => x.kind === 'cname' && x.name === 'shop.customer.com' && x.value === 'fallback.skyphusionwp.dev'));
  ok('delegated: customHostnameId + pending state', r.customHostnameId === 'CHID' && r.customHostnameState === 'pending');
  const entry = JSON.parse(s.kv.get('wp-blog.sub.workers.dev'));
  ok('delegated: registry MERGED (keeps script+kind, adds owner+host+state)', entry.script === 'site-blog' && entry.kind === 'wp' && entry.domainOwner === 'customer' && entry.customHostname === 'shop.customer.com' && entry.customHostnameState === 'pending');
  ok('delegated: stdout is the structured JSON, stderr prints the records for the customer', out.lines.join('').includes('"customHostnameId": "CHID"') && err.lines.join('\n').includes('anti-hostage'));
}

// ---- managed add: records placed on the zone we control, owner agency --------
{
  const s = makeStub({ seed: { key: 'wp-shop.sub.workers.dev', value: { script: 'site-shop', kind: 'wp' } } });
  const parsed = parseHostnameArgs(['add', 'shop', '--domain', 'shop.agency.net', '--mode', 'managed', '--cust-zone', CUST]);
  const r = await hostnameCommand(ctxOf(s), parsed, ENV, { out: sink(), err: sink() });
  ok('managed: records placed via the API on the customer zone', custWrites(s.calls).length === r.records.length && r.records.length >= 2);
  ok('managed: domainOwner is agency', r.domainOwner === 'agency');
  const entry = JSON.parse(s.kv.get('wp-shop.sub.workers.dev'));
  ok('managed: registry records the agency-owned custom hostname', entry.domainOwner === 'agency' && entry.customHostname === 'shop.agency.net');
}

// ---- dcv-delegation: the one-time _acme-challenge renewal CNAME, still no DNS
{
  const s = makeStub({ seed: { key: 'wp-blog.sub.workers.dev', value: { script: 'site-blog' } } });
  const parsed = parseHostnameArgs(['add', 'blog', '--domain', 'shop.customer.com', '--mode', 'delegated', '--dcv-delegation']);
  const r = await hostnameCommand(ctxOf(s), parsed, ENV, { out: sink(), err: sink() });
  const del = r.records.find((x) => x.name === '_acme-challenge.shop.customer.com');
  ok('dcv-delegation: emits the one-time renewal CNAME', del && del.kind === 'cname' && del.value === 'shop.customer.com.UUID123.dcv.cloudflare.com');
  ok('dcv-delegation: still nothing on the customer DNS', custWrites(s.calls).length === 0);
  ok('dcv-delegation: result flags dcvDelegation true', r.dcvDelegation === true);
}

// ---- status: polls the live state, persists active onto the entry -----------
{
  const s = makeStub({ activeOnCall: 1, seed: { key: 'wp-blog.sub.workers.dev', value: { script: 'site-blog', domainOwner: 'customer', customHostname: 'shop.customer.com', customHostnameId: 'CHID', customHostnameState: 'pending' } } });
  const parsed = parseHostnameArgs(['status', 'blog']);
  const r = await hostnameCommand(ctxOf(s), parsed, ENV, { out: sink(), err: sink() });
  ok('status: reports active when the live hostname + ssl are active', r.active === true && r.customHostnameState === 'active');
  const entry = JSON.parse(s.kv.get('wp-blog.sub.workers.dev'));
  ok('status: persists the new state back to the registry', entry.customHostnameState === 'active');
}

// ---- status: a site with no recorded custom hostname is a loud error --------
{
  const s = makeStub({ seed: { key: 'wp-bare.sub.workers.dev', value: { script: 'site-bare' } } });
  const parsed = parseHostnameArgs(['status', 'bare']);
  let threw = false;
  try { await hostnameCommand(ctxOf(s), parsed, ENV, { out: sink(), err: sink() }); } catch { threw = true; }
  ok('status: no recorded custom hostname throws rather than reporting a false state', threw);
}

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
