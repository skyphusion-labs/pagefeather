// Offline test of addCustomHostname + updateSite (#154). Stubs fetchImpl, routes
// by URL. Asserts the two ownership modes differ ONLY in who places DNS (the
// anti-hostage property: delegated touches no customer DNS), DCV delegation
// emits the one-time renewal CNAME, polling reaches active, and the registry
// records the owner + hostname + state.
import { addCustomHostname } from '../ops.mjs';
import { updateSite } from '../registry.mjs';

const SAAS = 'saaszone', CUST = 'custzone';
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

function stub({ activeOnCall = 1 } = {}) {
  const calls = [];
  let getN = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (url.endsWith(`/zones/${SAAS}/custom_hostnames`) && init.method === 'POST') {
      return resp('{"success":true,"result":{"id":"CHID","status":"pending","ssl":{"status":"pending_validation","validation_records":[{"txt_name":"_acme._cf.host","txt_value":"DCVVAL"}]},"ownership_verification":{"type":"txt","name":"_cf-ownership.host","value":"OWNVAL"}}}');
    }
    if (url.includes('/dcv_delegation/uuid')) return resp('{"success":true,"result":{"uuid":"UUID123"}}');
    if (url.includes('/custom_hostnames/CHID') && init.method === 'GET') {
      getN += 1;
      const active = getN >= activeOnCall;
      return resp(`{"success":true,"result":{"id":"CHID","status":"${active ? 'active' : 'pending'}","ssl":{"status":"${active ? 'active' : 'pending_validation'}"}}}`);
    }
    return resp('{"success":true,"result":{}}');
  };
  return { fetchImpl, calls };
}
const resp = (body) => ({ ok: true, status: 200, text: async () => body });
const ctxOf = (s) => ({ acct: 'A', token: 'T', fetchImpl: s.fetchImpl });
const custWrites = (calls) => calls.filter((c) => c.url.includes(`/zones/${CUST}/dns_records`) && c.method === 'POST');

// delegated: nothing is placed on the customer DNS; the records are returned.
{
  const s = stub();
  const r = await addCustomHostname(ctxOf(s), { saasZoneId: SAAS, hostname: 'shop.customer.com', fallbackHostname: 'fb.saas.example', mode: 'delegated' });
  ok('delegated creates the custom hostname', r.id === 'CHID' && s.calls[0].url.endsWith(`/zones/${SAAS}/custom_hostnames`));
  ok('delegated places NOTHING on the customer DNS (anti-hostage)', custWrites(s.calls).length === 0);
  const kinds = r.records.map((x) => `${x.kind}:${x.name}`);
  ok('delegated returns the CNAME + DCV + ownership records to hand the customer',
    kinds.includes('cname:shop.customer.com') && r.records.some((x) => x.kind === 'txt' && x.value === 'DCVVAL') && r.records.some((x) => x.value === 'OWNVAL'));
}

// managed: we place the records on the zone we control.
{
  const s = stub();
  const r = await addCustomHostname(ctxOf(s), { saasZoneId: SAAS, hostname: 'shop.agency.net', fallbackHostname: 'fb.saas.example', mode: 'managed', custZoneId: CUST });
  ok('managed places the records via the API on the customer zone', custWrites(s.calls).length === r.records.length && r.records.length >= 2);
  const cname = custWrites(s.calls).map((c) => JSON.parse(c.body)).find((b) => b.type === 'CNAME');
  ok('managed CNAME points at the SaaS fallback, grey cloud', cname && cname.content === 'fb.saas.example' && cname.proxied === false);
}

// DCV delegation (delegated): the one-time _acme-challenge renewal CNAME.
{
  const s = stub();
  const r = await addCustomHostname(ctxOf(s), { saasZoneId: SAAS, hostname: 'shop.customer.com', fallbackHostname: 'fb.saas.example', mode: 'delegated', dcvDelegation: true });
  ok('dcvDelegation reads the SaaS zone DCV uuid', s.calls.some((c) => c.url.includes('/dcv_delegation/uuid')));
  const del = r.records.find((x) => x.name === '_acme-challenge.shop.customer.com');
  ok('dcvDelegation emits the one-time renewal CNAME to <host>.<uuid>.dcv.cloudflare.com', del && del.kind === 'cname' && del.value === 'shop.customer.com.UUID123.dcv.cloudflare.com');
  ok('dcvDelegation still places nothing on the customer DNS', custWrites(s.calls).length === 0);
}

// polling: pending then active.
{
  const s = stub({ activeOnCall: 2 });
  const r = await addCustomHostname(ctxOf(s), { saasZoneId: SAAS, hostname: 'h.customer.com', fallbackHostname: 'fb', mode: 'delegated', pollMs: 5000, intervalMs: 1 });
  ok('poll reaches active (status.active true)', r.status.active === true);
}

// updateSite merges the owner + hostname + state into an existing entry.
{
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    if (init.method === 'GET') return resp('{"script":"c1-store","kind":"shop"}');
    return resp('{"success":true,"result":{}}');
  };
  const entry = await updateSite({ acct: 'A', token: 'T', fetchImpl }, { kvId: 'KV', hostname: 'shop.customer.com', patch: { domainOwner: 'customer', customHostname: 'shop.customer.com', customHostnameId: 'CHID', customHostnameState: 'pending' } });
  ok('updateSite merges onto the existing entry (keeps script+kind)', entry.script === 'c1-store' && entry.kind === 'shop' && entry.domainOwner === 'customer' && entry.customHostnameState === 'pending');
  const put = calls.find((c) => c.method === 'PUT');
  ok('updateSite writes the merged entry back', JSON.parse(put.body).customHostname === 'shop.customer.com');
}

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
