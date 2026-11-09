// Offline tests for the Hyperdrive config layer (issue #240). No network: cfFetch
// is driven by a fake fetchImpl that records the request and returns a canned CF
// response. Asserts the request SHAPE the real POST /hyperdrive/configs expects
// (the one seam that cannot be unit-verified against live CF), plus caching
// always disabled, the two origin shapes, and the error path.
import assert from 'node:assert';
import { CF_API } from '../../provision/cf.mjs';
import {
  buildOrigin, providerSqlMode, WP_SQL_MODE,
  createHyperdriveConfig, getHyperdriveConfig, listHyperdriveConfigs, deleteHyperdriveConfig,
} from '../hyperdrive.mjs';

let pass = 0, fail = 0;
async function ok(n, fn) {
  try { const r = await fn(); if (r) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } }
  catch (e) { fail++; console.log('FAIL', n, '- threw -', e.message); }
}
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
async function rejects(fn) { try { await fn(); return false; } catch { return true; } }

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, opts) => {
    const path = url.replace(CF_API, '');
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body;
    calls.push({ method: opts.method, path, body, headers: opts.headers });
    const { status = 200, obj } = handler(opts.method, path, body) || {};
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(obj ?? { success: true, result: null, errors: [] }) };
  };
  impl.calls = calls;
  return impl;
}
const ctxWith = (fetchImpl) => ({ acct: 'ACCT', token: 'TOKEN', fetchImpl });

// ---- providerSqlMode --------------------------------------------------------
await ok('providerSqlMode planetscale is the strict mode', () => providerSqlMode('planetscale') === WP_SQL_MODE);
await ok('providerSqlMode azure/vultr/external is empty', () =>
  ['azure', 'vultr', 'external'].every((p) => providerSqlMode(p) === ''));

// ---- buildOrigin ------------------------------------------------------------
await ok('buildOrigin public shape has port and no access fields', () => {
  const o = buildOrigin({ host: 'h', database: 'd', user: 'u', password: 'p' });
  return o.scheme === 'mysql' && o.port === 3306 && o.host === 'h' && o.user === 'u'
    && o.password === 'p' && !('access_client_id' in o);
});
await ok('buildOrigin honours a custom port', () =>
  buildOrigin({ host: 'h', database: 'd', user: 'u', password: 'p', port: 25060 }).port === 25060);
await ok('buildOrigin tunnel shape has access fields and NO port (CR #141)', () => {
  const o = buildOrigin({ host: 'h', database: 'd', user: 'u', password: 'p', accessClientId: 'cid', accessClientSecret: 'csec' });
  return o.access_client_id === 'cid' && o.access_client_secret === 'csec' && !('port' in o);
});
await ok('buildOrigin rejects a half Access origin (id without secret)', () =>
  throws(() => buildOrigin({ host: 'h', database: 'd', user: 'u', password: 'p', accessClientId: 'cid' })));
await ok('buildOrigin rejects a missing field', () =>
  throws(() => buildOrigin({ host: 'h', user: 'u', password: 'p' })) &&
  throws(() => buildOrigin({ host: 'h', database: 'd', user: 'u' })));

// ---- createHyperdriveConfig: the request shape ------------------------------
await ok('createHyperdriveConfig POSTs the documented body with caching disabled', async () => {
  const fetchImpl = fakeFetch((m, p) => ({ obj: { success: true, result: { id: 'cfg1', name: 'wp-x', caching: { disabled: true } }, errors: [] } }));
  const origin = buildOrigin({ host: 'h', database: 'd', user: 'u', password: 'secretpw' });
  const r = await createHyperdriveConfig(ctxWith(fetchImpl), { name: 'wp-x', origin });
  const call = fetchImpl.calls[0];
  return r.id === 'cfg1'
    && call.method === 'POST'
    && call.path === '/accounts/ACCT/hyperdrive/configs'
    && call.body.name === 'wp-x'
    && call.body.caching.disabled === true
    && call.body.origin.scheme === 'mysql'
    && call.body.origin.password === 'secretpw'
    && String(call.headers.authorization).includes('TOKEN');
});
await ok('createHyperdriveConfig throws on a CF error', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 400, obj: { success: false, result: null, errors: [{ code: 1004, message: 'bad origin' }] } }));
  return rejects(() => createHyperdriveConfig(ctxWith(fetchImpl), { name: 'wp-x', origin: buildOrigin({ host: 'h', database: 'd', user: 'u', password: 'p' }) }));
});
await ok('createHyperdriveConfig requires a name and an origin', async () =>
  (await rejects(() => createHyperdriveConfig(ctxWith(fakeFetch(() => ({}))), { origin: {} }))) &&
  (await rejects(() => createHyperdriveConfig(ctxWith(fakeFetch(() => ({}))), { name: 'x' }))));

// ---- get / list / delete ----------------------------------------------------
await ok('getHyperdriveConfig GETs by id', async () => {
  const fetchImpl = fakeFetch(() => ({ obj: { success: true, result: { id: 'cfgA', origin: { host: 'h' } }, errors: [] } }));
  const r = await getHyperdriveConfig(ctxWith(fetchImpl), 'cfgA');
  return r.id === 'cfgA' && fetchImpl.calls[0].method === 'GET' && fetchImpl.calls[0].path === '/accounts/ACCT/hyperdrive/configs/cfgA';
});
await ok('listHyperdriveConfigs returns the array', async () => {
  const fetchImpl = fakeFetch(() => ({ obj: { success: true, result: [{ id: 'a' }, { id: 'b' }], errors: [] } }));
  const r = await listHyperdriveConfigs(ctxWith(fetchImpl));
  return Array.isArray(r) && r.length === 2;
});
await ok('deleteHyperdriveConfig DELETEs by id', async () => {
  const fetchImpl = fakeFetch(() => ({ obj: { success: true, result: {}, errors: [] } }));
  const r = await deleteHyperdriveConfig(ctxWith(fetchImpl), 'cfgZ');
  return r === true && fetchImpl.calls[0].method === 'DELETE' && fetchImpl.calls[0].path.endsWith('/configs/cfgZ');
});

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
