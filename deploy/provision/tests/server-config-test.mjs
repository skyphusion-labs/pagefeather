// Unit test of the Worker security boundary (#182): the pure pieces of
// server-config.mjs, isolated from fetch. Proves each guard can go BOTH ways
// (reject AND accept), so none is a check that only ever fails or only ever
// passes.
import {
  authorize, validateRequest, resolveBase, selectToken, deriveTarget, BadRequest,
} from '../server-config.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };
const throwsWith = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

const BASES = JSON.stringify({ 'skyphusionwp.dev': { saasZoneId: 'Z1', workersSubdomain: 'skyphusionwp' } });
const reqWith = (auth) => new Request('https://p/', { method: 'POST', headers: auth == null ? {} : { authorization: auth } });

// authorize: constant-time bearer compare, fail closed.
ok('authorize: correct secret passes', (await authorize(reqWith('Bearer s3cr3t'), { PROVISION_AUTH: 's3cr3t' })) === true);
ok('authorize: wrong secret fails', (await authorize(reqWith('Bearer nope'), { PROVISION_AUTH: 's3cr3t' })) === false);
ok('authorize: a different-length secret fails (no length leak crash)', (await authorize(reqWith('Bearer short'), { PROVISION_AUTH: 'a-much-longer-secret-value' })) === false);
ok('authorize: no Authorization header fails', (await authorize(reqWith(null), { PROVISION_AUTH: 's3cr3t' })) === false);
ok('authorize: a non-Bearer scheme fails', (await authorize(reqWith('Basic s3cr3t'), { PROVISION_AUTH: 's3cr3t' })) === false);
ok('authorize: no configured secret fails CLOSED', (await authorize(reqWith('Bearer anything'), {})) === false);

// validateRequest: only kind/name/domain survive; extras are dropped.
{
  const out = validateRequest({ kind: 'wp', name: 'blog', domain: 'skyphusionwp.dev', modules: [1], kvId: 'x', secrets: { a: 1 } });
  ok('validateRequest: returns ONLY kind/name/domain', JSON.stringify(Object.keys(out).sort()) === '["domain","kind","name"]');
  ok('validateRequest: rejects a bad name', await throwsWith(() => validateRequest({ kind: 'wp', name: 'Bad_Name', domain: 'skyphusionwp.dev' }), /name must be/));
  ok('validateRequest: rejects a bad kind', await throwsWith(() => validateRequest({ kind: 'x', name: 'blog', domain: 'skyphusionwp.dev' }), /kind must be/));
  ok('validateRequest: rejects a missing domain', await throwsWith(() => validateRequest({ kind: 'wp', name: 'blog' }), /domain is required/));
  let isBadRequest = false;
  try { validateRequest({}); } catch (e) { isBadRequest = e instanceof BadRequest; }
  ok('validateRequest: errors are BadRequest (map to 400)', isBadRequest);
}

// resolveBase: an owned base resolves; an unowned one is a BadRequest.
ok('resolveBase: an owned base resolves to its zone', resolveBase({ WFP_BASES: BASES }, 'skyphusionwp.dev').saasZoneId === 'Z1');
ok('resolveBase: an unowned base is BadRequest', await throwsWith(() => resolveBase({ WFP_BASES: BASES }, 'evil.com'), /not an owned base/));

// selectToken: the split. wp never gets the elevated token.
ok('selectToken: wp -> the restricted token', selectToken({ WP_PROVISION_TOKEN: 'WP', SHOP_PROVISION_TOKEN: 'SHOP' }, 'wp') === 'WP');
ok('selectToken: shop -> the elevated token', selectToken({ WP_PROVISION_TOKEN: 'WP', SHOP_PROVISION_TOKEN: 'SHOP' }, 'shop') === 'SHOP');
ok('selectToken: a missing token throws', await throwsWith(() => selectToken({}, 'wp'), /WP_PROVISION_TOKEN/));

// deriveTarget: server-built routing, no caller input beyond name + base choice.
{
  const env = { WFP_BASES: BASES, WFP_KV_ID: 'KV', WFP_NAMESPACE: 'wp-wfp' };
  const wp = deriveTarget(env, { kind: 'wp', name: 'blog', domain: 'skyphusionwp.dev' });
  ok('deriveTarget wp: script, hostname, zone, kv from the server',
    wp.script === 'site-blog' && wp.hostname === 'blog.skyphusionwp.dev' && wp.saasZoneId === 'Z1' && wp.kvId === 'KV' && wp.namespace === 'wp-wfp');
  const shop = deriveTarget(env, { kind: 'shop', name: 'store', domain: 'skyphusionwp.dev' });
  ok('deriveTarget shop: workers.dev hostname off the base subdomain',
    shop.script === 'c1-store' && shop.hostname === 'c1-store.skyphusionwp.workers.dev');
}

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
