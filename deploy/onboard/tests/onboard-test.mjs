// Offline tests for the onboarding orchestrator (issue #240). Every provider
// path runs with a fake CF fetch and a fake CLI runner, so no network, no az,
// no pscale, no terraform, no spend. Asserts: arg parsing, the per-provider
// origin + side-effect sequence, the SQL_MODE contract, the Azure reuse branch
// (no recreate), the PlanetScale direct-host guard, the Vultr small-plan warning,
// --dry-run leaking no secret, and that a password never reaches a log or stdout.
import assert from 'node:assert';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CF_API } from '../../provision/cf.mjs';
import { WP_SQL_MODE } from '../hyperdrive.mjs';
import { parseArgs, onboard, PROVIDERS, AZURE_LIVE_HYPERDRIVE_ID, PS_ANYCAST_HOST } from '../onboard.mjs';

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
    calls.push({ method: opts.method, path, body });
    const { status = 200, obj } = handler(opts.method, path, body) || {};
    return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(obj ?? { success: true, result: null, errors: [] }) };
  };
  impl.calls = calls;
  return impl;
}
function fakeRun(impl) {
  const calls = [];
  const f = async (cmd, args, opt) => { calls.push({ cmd, args, opt }); return (impl && impl(cmd, args, opt)) || { code: 0, stdout: '', stderr: '' }; };
  f.calls = calls;
  return f;
}
// A CF handler that creates a config and echoes a stripped origin (no password,
// as real CF does), plus a planetScale signature on the signature route.
function cfHandler(m, p, b) {
  if (p.endsWith('/createDatabaseSignature')) return { obj: { success: true, result: { account_id: 'ACCT', timestamp: 1, signature: 'sig' }, errors: [] } };
  if (m === 'POST' && p.endsWith('/hyperdrive/configs')) return { obj: { success: true, result: { id: 'cfg-new', name: b.name, origin: { scheme: 'mysql', host: b.origin.host, database: b.origin.database, user: b.origin.user }, caching: { disabled: true } }, errors: [] } };
  if (m === 'GET' && p.includes('/hyperdrive/configs/')) return { obj: { success: true, result: { id: p.split('/').pop(), origin: { host: 'wpref-mysql.mysql.database.azure.com', database: 'wordpress', user: 'wpadmin' } }, errors: [] } };
  return { obj: { success: true, result: null, errors: [] } };
}
function makeIo({ env = {}, fetchImpl, run, name = 'wp-site', out, dryRun = false }) {
  const logs = [];
  return {
    env, fetchImpl, run, name, out, dryRun,
    log: (mm) => logs.push(String(mm)),
    acct: 'ACCT', token: 'TOKEN', mysqlTfDir: '/nonexistent',
    _logs: logs,
  };
}
const noSecret = (io, result, secret) =>
  !io._logs.join('\n').includes(secret) && !JSON.stringify(result).includes(secret);

// ---- parseArgs --------------------------------------------------------------
await ok('parseArgs accepts a provider and --name/--out/--dry-run', () => {
  const a = parseArgs(['external', '--name', 'wp-x', '--out', '/t/f', '--dry-run']);
  return a.provider === 'external' && a.opts.name === 'wp-x' && a.opts.out === '/t/f' && a.opts.dryRun === true;
});
await ok('parseArgs lists all four providers', () =>
  JSON.stringify(PROVIDERS) === JSON.stringify(['azure', 'planetscale', 'vultr', 'external']));
await ok('parseArgs rejects an unknown provider', () => throws(() => parseArgs(['mongo', '--name', 'x'])));
await ok('parseArgs rejects a missing provider', () => throws(() => parseArgs([])));
await ok('parseArgs rejects an unknown option (secrets are env-only)', () => throws(() => parseArgs(['external', '--password', 'p'])));

// ---- name validation --------------------------------------------------------
await ok('onboard rejects a bad config name', async () =>
  rejects(() => onboard('external', makeIo({ name: 'Bad_Name', fetchImpl: fakeFetch(cfHandler) }))));
await ok('onboard requires a name', async () =>
  rejects(() => onboard('external', makeIo({ name: undefined, fetchImpl: fakeFetch(cfHandler) }))));

// ---- external ---------------------------------------------------------------
await ok('external: creates a caching-disabled config and carries no SQL_MODE', async () => {
  const fetchImpl = fakeFetch(cfHandler);
  const io = makeIo({ env: { MYSQL_HOST: 'db.example.com', MYSQL_USER: 'wp', MYSQL_PASSWORD: 'extSecretPW', MYSQL_DATABASE: 'wordpress' }, fetchImpl });
  const r = await onboard('external', io);
  const post = fetchImpl.calls.find((c) => c.method === 'POST');
  return r.hyperdrive_id === 'cfg-new' && r.sql_mode === '' && r.host === 'db.example.com'
    && post.body.caching.disabled === true && post.body.origin.port === 3306
    && post.body.origin.password === 'extSecretPW'
    && noSecret(io, r, 'extSecretPW');
});
await ok('external: Access-tunnel origin (CR #141) has access fields and no port', async () => {
  const fetchImpl = fakeFetch(cfHandler);
  const io = makeIo({ env: { MYSQL_HOST: 'tun.example.com', MYSQL_USER: 'wp', MYSQL_PASSWORD: 'pw', MYSQL_DATABASE: 'wordpress', MYSQL_ACCESS_CLIENT_ID: 'cid', MYSQL_ACCESS_CLIENT_SECRET: 'csec' }, fetchImpl });
  await onboard('external', io);
  const o = fetchImpl.calls.find((c) => c.method === 'POST').body.origin;
  return o.access_client_id === 'cid' && !('port' in o);
});
await ok('external: a missing env var is rejected', async () =>
  rejects(() => onboard('external', makeIo({ env: { MYSQL_HOST: 'h' }, fetchImpl: fakeFetch(cfHandler) }))));

// ---- azure ------------------------------------------------------------------
await ok('azure: relaxes sql_mode via az then creates a config, SQL_MODE empty', async () => {
  const fetchImpl = fakeFetch(cfHandler);
  const run = fakeRun(() => ({ code: 0, stdout: '', stderr: '' }));
  const io = makeIo({ env: { AZ_RESOURCE_GROUP: 'rg', AZ_SERVER_NAME: 'wpref-mysql', AZ_MYSQL_PASSWORD: 'azSecretPW' }, fetchImpl, run });
  const r = await onboard('azure', io);
  const az = run.calls.find((c) => c.cmd === 'az');
  return r.sql_mode === '' && r.hyperdrive_id === 'cfg-new'
    && az && az.args.includes('sql_mode') && az.args.includes(WP_SQL_MODE)
    && noSecret(io, r, 'azSecretPW');
});
await ok('azure: with no resource group the relax is skipped, config still made', async () => {
  const fetchImpl = fakeFetch(cfHandler);
  const run = fakeRun(() => ({ code: 0 }));
  const io = makeIo({ env: { AZ_MYSQL_PASSWORD: 'pw' }, fetchImpl, run });
  const r = await onboard('azure', io);
  return r.hyperdrive_id === 'cfg-new' && run.calls.every((c) => c.cmd !== 'az');
});
await ok('azure REUSE: with HYPERDRIVE_ID it verifies and does NOT recreate', async () => {
  const fetchImpl = fakeFetch(cfHandler);
  const run = fakeRun(() => ({ code: 0 }));
  const io = makeIo({ env: { HYPERDRIVE_ID: AZURE_LIVE_HYPERDRIVE_ID, AZ_RESOURCE_GROUP: 'rg', AZ_SERVER_NAME: 's' }, fetchImpl, run });
  const r = await onboard('azure', io);
  const posted = fetchImpl.calls.some((c) => c.method === 'POST');
  const got = fetchImpl.calls.find((c) => c.method === 'GET');
  return r.reused === true && r.hyperdrive_id === AZURE_LIVE_HYPERDRIVE_ID && !posted && got && got.path.endsWith(AZURE_LIVE_HYPERDRIVE_ID);
});

// ---- vultr ------------------------------------------------------------------
function vultrRun(plan) {
  return fakeRun((cmd, args) => {
    if (cmd !== 'terraform') return { code: 0 };
    if (args[0] === 'output') {
      const which = args[2];
      const map = { host: 'mysql-site.skyphusion.org', user: 'wp', database: 'wordpress', password: 'vultrSecretPW' };
      return { code: 0, stdout: map[which] + '\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  });
}
await ok('vultr: terraform apply then a config to the box host; password never logged', async () => {
  const fetchImpl = fakeFetch(cfHandler);
  const run = vultrRun('vc2-2c-4gb');
  const io = makeIo({ env: { VULTR_API_KEY: 'k', MYSQL_ZONE_ID: 'z', MYSQL_HOST: 'mysql-site.skyphusion.org', MYSQL_PLAN: 'vc2-2c-4gb' }, fetchImpl, run });
  const r = await onboard('vultr', io);
  const post = fetchImpl.calls.find((c) => c.method === 'POST');
  const applied = run.calls.some((c) => c.cmd === 'terraform' && c.args[0] === 'apply');
  return r.sql_mode === '' && post.body.origin.host === 'mysql-site.skyphusion.org'
    && post.body.origin.password === 'vultrSecretPW' && applied && noSecret(io, r, 'vultrSecretPW');
});
await ok('vultr: a vc2-1c plan emits the flaky-under-load warning', async () => {
  const fetchImpl = fakeFetch(cfHandler);
  const io = makeIo({ env: { VULTR_API_KEY: 'k', MYSQL_ZONE_ID: 'z', MYSQL_HOST: 'h', MYSQL_PLAN: 'vc2-1c-2gb' }, fetchImpl, run: vultrRun('vc2-1c-2gb') });
  await onboard('vultr', io);
  return io._logs.some((l) => l.includes('WARNING') && l.includes('vc2-1c-2gb'));
});

// ---- planetscale ------------------------------------------------------------
function psRun() {
  return fakeRun((cmd, args) => {
    if (cmd === 'pscale' && args[0] === 'database') return { code: 0, stdout: '{"name":"wp-on-cf-a2"}', stderr: '' };
    if (cmd === 'pscale' && args[0] === 'password') return { code: 0, stdout: JSON.stringify({ username: 'psuser', plain_text: 'psSecretPW' }), stderr: '' };
    return { code: 0 };
  });
}
await ok('planetscale: CF-sign, pscale create, direct host, SQL_MODE set, signature piped', async () => {
  const fetchImpl = fakeFetch(cfHandler);
  const run = psRun();
  const io = makeIo({ env: { PSCALE_ORG: 'org', PS_DB_NAME: 'wp-on-cf-a2', PS_REGION: 'us-west' }, fetchImpl, run });
  const r = await onboard('planetscale', io);
  const post = fetchImpl.calls.find((c) => c.method === 'POST' && c.path.endsWith('/hyperdrive/configs'));
  const dbCreate = run.calls.find((c) => c.cmd === 'pscale' && c.args[0] === 'database');
  const sig = JSON.parse(dbCreate.opt.input);
  return r.sql_mode === WP_SQL_MODE && r.host === 'us-west.connect.psdb.cloud'
    && post.body.origin.host === 'us-west.connect.psdb.cloud'
    && post.body.origin.user === 'psuser' && post.body.origin.password === 'psSecretPW'
    && dbCreate.args.includes('--cloudflare-billing') && sig.signature === 'sig'
    && noSecret(io, r, 'psSecretPW');
});
await ok('planetscale: refuses the anycast optimized host', async () =>
  rejects(() => onboard('planetscale', makeIo({ env: { PSCALE_ORG: 'org', PS_DB_NAME: 'd', PS_DIRECT_HOST: PS_ANYCAST_HOST }, fetchImpl: fakeFetch(cfHandler), run: psRun() }))));

// ---- dry-run ----------------------------------------------------------------
await ok('dry-run: plans without a fetch, a run, or a secret', async () => {
  const fetchImpl = fakeFetch(cfHandler);
  const run = fakeRun(() => ({ code: 0 }));
  const io = makeIo({ env: { MYSQL_HOST: 'h', MYSQL_USER: 'u', MYSQL_PASSWORD: 'drySecretPW', MYSQL_DATABASE: 'd' }, fetchImpl, run, dryRun: true });
  const r = await onboard('external', io);
  return r.dryRun === true && r.caching === 'disabled' && fetchImpl.calls.length === 0 && run.calls.length === 0 && !JSON.stringify(r).includes('drySecretPW');
});
await ok('dry-run: planetscale plan shows the SQL_MODE requirement', async () => {
  const io = makeIo({ env: { PSCALE_ORG: 'o', PS_DB_NAME: 'd' }, fetchImpl: fakeFetch(cfHandler), run: fakeRun(() => ({ code: 0 })), dryRun: true });
  const r = await onboard('planetscale', io);
  return r.sql_mode === WP_SQL_MODE;
});

// ---- --out contract file ----------------------------------------------------
await ok('--out writes HYPERDRIVE_ID and SQL_MODE for Phase 2', async () => {
  const outPath = join(process.env.TMPDIR || '/tmp', `onboard-out-${process.pid}.env`);
  const fetchImpl = fakeFetch(cfHandler);
  const io = makeIo({ env: { PSCALE_ORG: 'o', PS_DB_NAME: 'd', PS_REGION: 'us-west' }, fetchImpl, run: psRun(), out: outPath });
  const r = await onboard('planetscale', io);
  const text = await readFile(outPath, 'utf8');
  await rm(outPath, { force: true });
  return text.includes(`HYPERDRIVE_ID=${r.hyperdrive_id}`) && text.includes(`SQL_MODE=${WP_SQL_MODE}`);
});

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
