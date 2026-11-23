// #1364: one-click (deploy/provision, and the vendored copy the button runs) renders
// DB_QUERY_TIMEOUT_MS for an approach A site when it is set, renders nothing when
// it is unset, and refuses a value that is not digits from 1 to 600000 before any
// bundle read. The same rule as connector.mjs queryTimeoutMs, except a bad value
// stops the provision instead of falling back.
//   node deploy/provision/tests/db-query-timeout-test.mjs
import { readFileSync } from 'node:fs';

const m = await import('../wp-site-config.mjs');
const vend = await import('../../oneclick/vendor/provision/wp-site-config.mjs');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };
const text = (bs, n) => {
  const b = (bs || []).find((x) => x && x.type === 'plain_text' && x.name === n);
  return b ? b.text : null;
};
const inputs = typeof m.dbQueryTimeoutInputs === 'function' ? m.dbQueryTimeoutInputs : () => { throw new Error('dbQueryTimeoutInputs is not exported'); };
const render = (mod, env) => mod.aBindings({
  mediaBucket: 'b', hyperdriveId: 'HDID', siteOrigin: 'https://s.example', ...mod.dbQueryTimeoutInputs(env),
});
const tryRender = (mod, env) => { try { return render(mod, env); } catch (e) { return { error: e.message }; } };

let r = tryRender(m, {});
ok('unset adds no DB_QUERY_TIMEOUT_MS', !r.error && text(r, 'DB_QUERY_TIMEOUT_MS') === null);
r = tryRender(m, { DB_QUERY_TIMEOUT_MS: '' });
ok('empty adds no DB_QUERY_TIMEOUT_MS', !r.error && text(r, 'DB_QUERY_TIMEOUT_MS') === null);
r = tryRender(m, { DB_QUERY_TIMEOUT_MS: '45000' });
ok('45000 renders the plain var', !r.error && text(r, 'DB_QUERY_TIMEOUT_MS') === '45000');
r = tryRender(m, { DB_QUERY_TIMEOUT_MS: '00045000' });
ok('a leading zero renders 45000', !r.error && text(r, 'DB_QUERY_TIMEOUT_MS') === '45000');
r = tryRender(m, { DB_QUERY_TIMEOUT_MS: '1' });
ok('1 renders 1', !r.error && text(r, 'DB_QUERY_TIMEOUT_MS') === '1');
r = tryRender(m, { DB_QUERY_TIMEOUT_MS: '600000' });
ok('600000 renders 600000', !r.error && text(r, 'DB_QUERY_TIMEOUT_MS') === '600000');
ok('b-dosql vars do not carry it', text(m.bDosqlVars({ siteOrigin: 'https://s.example' }), 'DB_QUERY_TIMEOUT_MS') === null);

for (const bad of ['0', '600001', 'abc', '1.5', '-1', '1e3', ' 45000']) {
  r = tryRender(m, { DB_QUERY_TIMEOUT_MS: bad });
  ok('refused ' + JSON.stringify(bad) + ' and the message names the setting', Boolean(r.error) && r.error.includes('DB_QUERY_TIMEOUT_MS') && r.error.includes(bad));
}
let threw = false;
try { inputs({ DB_QUERY_TIMEOUT_MS: '0' }); } catch (e) { threw = e.message.includes('DB_QUERY_TIMEOUT_MS'); }
ok('dbQueryTimeoutInputs itself refuses, so the callers refuse before IO', threw);

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
for (const f of ['../cli.mjs', '../server-config.mjs']) {
  const s = src(f);
  ok(f + ' forwards dbQueryTimeoutInputs into the approach-A bindings', /aBindings\(\{[\s\S]{0,1400}\.\.\.dbQueryTimeoutInputs\(env\)/.test(s));
  ok(f + ' checks it before any IO', /dbQueryTimeoutInputs\(env\)/.test(s) && /aCacheInputs\(env\)/.test(s));
}
ok('a-vars-toml.mjs passes the setting into aVars', /dbQueryTimeoutInputs\(process\.env\)/.test(src('../a-vars-toml.mjs')));

const pair = (a, b) => readFileSync(new URL(a, import.meta.url), 'utf8') === readFileSync(new URL(b, import.meta.url), 'utf8');
ok('the vendored wp-site-config.mjs matches', pair('../wp-site-config.mjs', '../../oneclick/vendor/provision/wp-site-config.mjs'));
ok('the vendored server-config.mjs matches', pair('../server-config.mjs', '../../oneclick/vendor/provision/server-config.mjs'));
r = tryRender(vend, { DB_QUERY_TIMEOUT_MS: '45000' });
ok('the vendored copy renders 45000', !r.error && text(r, 'DB_QUERY_TIMEOUT_MS') === '45000');
r = tryRender(vend, {});
ok('the vendored copy renders nothing when unset', !r.error && text(r, 'DB_QUERY_TIMEOUT_MS') === null);

const { buildServerCfg, BadRequest } = await import('../server-config.mjs');
let early = null;
try {
  await buildServerCfg({ DB_QUERY_TIMEOUT_MS: 'nope' }, { kind: 'a', name: 'mystore', domain: 'workers.dev', hyperdriveId: 'ab'.repeat(16), tablePrefix: 'wp_mystore_' });
} catch (e) { early = e; }
ok('buildServerCfg refuses a bad value before the bundle is read', early instanceof BadRequest && early.message.includes('DB_QUERY_TIMEOUT_MS') && !/bundle/i.test(early.message));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
