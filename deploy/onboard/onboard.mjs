#!/usr/bin/env node
// Onboarding Phase 1 (issue #240): PROVIDER choice -> a ready Hyperdrive config.
//
//   node deploy/onboard/onboard.mjs <provider> --name <config-name> [--out FILE] [--dry-run]
//
// provider is one of: azure, planetscale, vultr, external. The step sets up the
// provider's backing (where needed), creates a Hyperdrive config with caching
// DISABLED pointing at it, and prints the Phase 2 contract: the config id and
// whether HYPERDRIVE_SQL_MODE is required. Phase 2 (site add --kind a <name>
// --hyperdrive <id>) consumes HYPERDRIVE_ID and SQL_MODE.
//
// SECRETS: every password / key / signature is read from the ENVIRONMENT, never
// from argv (argv is visible in `ps`) and never a tracked file, and is never
// logged. Only non-secret fields (config id, host, db, user, sql_mode) are
// printed. See deploy/onboard/README.md for the full env matrix per provider.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildOrigin, providerSqlMode, createHyperdriveConfig, getHyperdriveConfig, WP_SQL_MODE,
} from './hyperdrive.mjs';
import { cfFetch, opError } from '../provision/cf.mjs';

export const PROVIDERS = ['azure', 'planetscale', 'vultr', 'external'];

// A Hyperdrive config name: lower case, digits, hyphens, 1 to 40, no leading or
// trailing hyphen. It is the only operator-supplied label that reaches the CF
// resource, so it is validated like a site name (shared.mjs SITE_NAME_RE, widened
// to 40 because a config name is not a hostname label).
export const CONFIG_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

// Azure Flexible Server: the sql_mode VALUE the relax sets (drops the strict
// modes, keeps these two), so WordPress zero-dates and DEFAULT '0000-...' work.
export const AZURE_SQL_MODE_VALUE = WP_SQL_MODE;
// The live Azure reference server + config (docs/approach-a.md, approach-a2.md).
// The config id is an opaque resource id, not a secret; the password is NOT here.
export const AZURE_DEFAULT_HOST = 'wpref-mysql.mysql.database.azure.com';
export const AZURE_LIVE_HYPERDRIVE_ID = '84ab72d4ef5d479a99348b436b44f717';
// PlanetScale's anycast "optimized" host: ~27 ms slower per query through
// Hyperdrive (docs/approach-a2.md result 1). The onboarding step refuses it.
export const PS_ANYCAST_HOST = 'aws.connect.psdb.cloud';
// Vultr plans that measured flaky under concurrent load this session.
export const VULTR_SMALL_PLAN_PREFIX = 'vc2-1c';

export function parseArgs(argv) {
  const [provider, ...rest] = argv;
  if (!provider || !PROVIDERS.includes(provider)) {
    throw new Error(`usage: onboard <provider> --name <config-name> [--out FILE] [--dry-run]; provider is one of: ${PROVIDERS.join(', ')}`);
  }
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--name') opts.name = rest[++i];
    else if (a === '--out') opts.out = rest[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`unknown option: ${a} (secrets and provider params come from the environment, see README)`);
  }
  return { provider, opts };
}

function envOr(env, k, d) {
  return env[k] !== undefined && env[k] !== '' ? env[k] : d;
}
function requireEnv(env, keys, provider) {
  for (const k of keys) {
    if (!env[k]) throw new Error(`${provider} provider needs ${k} in the environment`);
  }
}

// A default shell runner: spawn a command, feed optional stdin, collect output.
// Injected (io.run) so tests drive every provider path with no real CLI.
export function makeRunner() {
  return (cmd, args, { cwd, input } = {}) => new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) p.stdin.write(input);
    p.stdin.end();
  });
}

// ---- Azure ------------------------------------------------------------------
// Idempotent server-side sql_mode relax. Needs the resource group and server
// name; when they are not given it is skipped with a notice, because the live
// wpref server is already relaxed (this is the common case for the reference
// backend). The az CLI auth is the operator's own; we never pass a secret.
export async function azureRelax(io) {
  const { env, run, log } = io;
  const rg = env.AZ_RESOURCE_GROUP, srv = env.AZ_SERVER_NAME;
  if (!rg || !srv) {
    log('az: AZ_RESOURCE_GROUP / AZ_SERVER_NAME not set; skipping the sql_mode relax (the live wpref server is already relaxed)');
    return false;
  }
  log(`az: relax sql_mode on ${srv} to ${AZURE_SQL_MODE_VALUE}`);
  const r = await run('az', ['mysql', 'flexible-server', 'parameter', 'set',
    '--resource-group', rg, '--server-name', srv, '--name', 'sql_mode', '--value', AZURE_SQL_MODE_VALUE]);
  if (r.code !== 0) throw new Error(`az parameter set failed (code ${r.code}): ${r.stderr.trim()}`);
  return true;
}

async function resolveAzure(io) {
  const { env } = io;
  await azureRelax(io);
  requireEnv(env, ['AZ_MYSQL_PASSWORD'], 'azure');
  const host = envOr(env, 'AZ_MYSQL_HOST', AZURE_DEFAULT_HOST);
  const database = envOr(env, 'AZ_MYSQL_DATABASE', 'wordpress');
  const user = envOr(env, 'AZ_MYSQL_USER', 'wpadmin');
  const origin = buildOrigin({ host, database, user, password: env.AZ_MYSQL_PASSWORD, port: 3306 });
  return { origin, host, database, user, note: 'Azure MySQL Flexible Server (SSL); sql_mode relaxed at the server, so no per-statement mode' };
}

// ---- external ---------------------------------------------------------------
async function resolveExternal(io) {
  const { env } = io;
  requireEnv(env, ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'], 'external');
  const accessClientId = env.MYSQL_ACCESS_CLIENT_ID || undefined;
  const accessClientSecret = env.MYSQL_ACCESS_CLIENT_SECRET || undefined;
  const origin = buildOrigin({
    host: env.MYSQL_HOST, database: env.MYSQL_DATABASE, user: env.MYSQL_USER, password: env.MYSQL_PASSWORD,
    port: Number(envOr(env, 'MYSQL_PORT', '3306')), accessClientId, accessClientSecret,
  });
  const note = accessClientId
    ? 'external, Access-tunnel origin (CR #141): no public port, no SSL on the box'
    : 'external public host: SSL required at the server';
  return { origin, host: env.MYSQL_HOST, database: env.MYSQL_DATABASE, user: env.MYSQL_USER, note };
}

// ---- Vultr ------------------------------------------------------------------
async function tf(run, dir, args) {
  const r = await run('terraform', args, { cwd: dir });
  if (r.code !== 0) throw new Error(`terraform ${args[0]} failed (code ${r.code}): ${r.stderr.trim()}`);
  return r.stdout;
}
async function resolveVultr(io, name) {
  const { env, run, log } = io;
  requireEnv(env, ['VULTR_API_KEY', 'MYSQL_ZONE_ID', 'MYSQL_HOST'], 'vultr');
  const region = envOr(env, 'MYSQL_REGION', 'ord');
  // Production default is larger than deploy/mysql's own default: vc2-1c-2gb was
  // flaky under heavy concurrent load this session (docs/approach-a2.md).
  const plan = envOr(env, 'MYSQL_PLAN', 'vc2-2c-4gb');
  if (plan.startsWith(VULTR_SMALL_PLAN_PREFIX)) {
    log(`vultr: WARNING plan ${plan} was flaky under concurrent load this session; >= vc2-2c-4gb is recommended for production`);
  }
  const dir = io.mysqlTfDir;
  log(`terraform: Vultr MariaDB for ${name} (${env.MYSQL_HOST}, region ${region}, plan ${plan})`);
  await tf(run, dir, ['init', '-input=false', '-reconfigure']);
  await tf(run, dir, ['workspace', 'select', '-or-create', name]);
  await tf(run, dir, ['apply', '-input=false', '-auto-approve',
    '-var', `name=${name}`, '-var', `zone_id=${env.MYSQL_ZONE_ID}`, '-var', `hostname=${env.MYSQL_HOST}`,
    '-var', `region=${region}`, '-var', `plan=${plan}`]);
  const host = (await tf(run, dir, ['output', '-raw', 'host'])).trim();
  const user = (await tf(run, dir, ['output', '-raw', 'user'])).trim();
  const database = (await tf(run, dir, ['output', '-raw', 'database'])).trim();
  const password = (await tf(run, dir, ['output', '-raw', 'password'])).trim(); // sensitive: never logged
  const origin = buildOrigin({ host, database, user, password, port: 3306 });
  return { origin, host, database, user, note: `Vultr MariaDB (plan ${plan}, region ${region}), SSL; port 3306 open to Cloudflare ranges only` };
}

// ---- PlanetScale ------------------------------------------------------------
async function resolvePlanetscale(io) {
  const { env, run, log } = io;
  requireEnv(env, ['PSCALE_ORG', 'PS_DB_NAME'], 'planetscale');
  const org = env.PSCALE_ORG, db = env.PS_DB_NAME;
  const region = envOr(env, 'PS_REGION', 'us-west');
  const clusterSize = envOr(env, 'PS_CLUSTER_SIZE', 'PS-10');
  const pwName = envOr(env, 'PS_PASSWORD_NAME', 'hyperdrive');
  // 1. CF-billed signature (one Cloudflare bill). Works with the CF API token.
  log('cf: createDatabaseSignature (one Cloudflare bill)');
  const sigRes = await cfFetch(io.token, 'POST',
    `/accounts/${io.acct}/hyperdrive/integrationsOperations/planetScale/createDatabaseSignature`,
    { fetchImpl: io.fetchImpl });
  if (!sigRes.ok || !sigRes.result) throw opError('createDatabaseSignature', 'planetScale', sigRes);
  const signaturePayload = JSON.stringify(sigRes.result); // { account_id, timestamp, signature }
  // 2. pscale database create, signature piped on stdin (@-).
  log(`pscale: database create ${db} (org ${org}, region ${region}, ${clusterSize}, CF-billed)`);
  const create = await run('pscale', ['database', 'create', db, '--org', org, '--region', region,
    '--cluster-size', clusterSize, '--cloudflare-billing', '@-', '--format', 'json'], { input: signaturePayload });
  if (create.code !== 0) throw new Error(`pscale database create failed (code ${create.code}): ${create.stderr.trim()}`);
  // 3. Branch password for the Hyperdrive origin.
  log(`pscale: password create ${db} main ${pwName}`);
  const pw = await run('pscale', ['password', 'create', db, 'main', pwName, '--format', 'json']);
  if (pw.code !== 0) throw new Error(`pscale password create failed (code ${pw.code}): ${pw.stderr.trim()}`);
  let creds;
  try { creds = JSON.parse(pw.stdout); } catch { throw new Error('pscale password create did not return JSON'); }
  const user = creds.username || creds.user;
  const password = creds.plain_text || creds.plaintext || creds.password;
  if (!user || !password) throw new Error('pscale password create JSON had no username/password');
  // 4. DIRECT region host, never the anycast optimized host.
  const host = env.PS_DIRECT_HOST || `${region}.connect.psdb.cloud`;
  if (host === PS_ANYCAST_HOST) {
    throw new Error(`refusing the anycast host ${PS_ANYCAST_HOST}: ~27 ms slower per query through Hyperdrive; set PS_DIRECT_HOST to the direct region host`);
  }
  const origin = buildOrigin({ host, database: db, user, password, port: 3306 });
  return { origin, host, database: db, user, note: `PlanetScale Vitess (${clusterSize}, ${region}), CF-billed; direct host. HYPERDRIVE_SQL_MODE required (Vitess strict). Vitess schema-propagation lag: install/activate may need a re-run.` };
}

const RESOLVERS = { azure: resolveAzure, external: resolveExternal, planetscale: resolvePlanetscale };

// A dry-run PLAN: no secrets, no create, no side effects. It states the provider,
// the non-secret target it would use, and that caching is disabled.
function planFor(provider, name, env) {
  const base = { provider, config_name: name, caching: 'disabled', sql_mode: providerSqlMode(provider) };
  if (provider === 'azure') return { ...base, host: envOr(env, 'AZ_MYSQL_HOST', AZURE_DEFAULT_HOST), database: envOr(env, 'AZ_MYSQL_DATABASE', 'wordpress'), user: envOr(env, 'AZ_MYSQL_USER', 'wpadmin'), note: 'would relax sql_mode (if AZ_RESOURCE_GROUP/AZ_SERVER_NAME set), then create or reuse a config' };
  if (provider === 'external') return { ...base, host: env.MYSQL_HOST || '(MYSQL_HOST)', database: env.MYSQL_DATABASE || '(MYSQL_DATABASE)', user: env.MYSQL_USER || '(MYSQL_USER)', access: Boolean(env.MYSQL_ACCESS_CLIENT_ID) };
  if (provider === 'vultr') return { ...base, hostname: env.MYSQL_HOST || '(MYSQL_HOST)', region: envOr(env, 'MYSQL_REGION', 'ord'), plan: envOr(env, 'MYSQL_PLAN', 'vc2-2c-4gb'), note: 'would terraform apply deploy/mysql, then create a config to the host' };
  return { ...base, org: env.PSCALE_ORG || '(PSCALE_ORG)', database: env.PS_DB_NAME || '(PS_DB_NAME)', region: envOr(env, 'PS_REGION', 'us-west'), cluster_size: envOr(env, 'PS_CLUSTER_SIZE', 'PS-10'), note: 'would CF-sign, pscale database+password create, then a config to the direct host' };
}

// Orchestrate one onboarding. io: { env, run, fetchImpl, log, acct, token, name,
// out, dryRun, mysqlTfDir }. Returns the Phase 2 contract object.
export async function onboard(provider, io) {
  const name = io.name;
  if (!name) throw new Error('set --name <config-name> (or ONBOARD_NAME)');
  if (!CONFIG_NAME_RE.test(name)) throw new Error(`config name ${JSON.stringify(name)}: lower case, digits, hyphens, 1 to 40, no leading or trailing hyphen`);
  const sqlMode = providerSqlMode(provider);

  if (io.dryRun) {
    return { dryRun: true, ...planFor(provider, name, io.env) };
  }

  if (!io.acct || !io.token) throw new Error('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  const ctx = { acct: io.acct, token: io.token, fetchImpl: io.fetchImpl };

  // Azure reuse: with HYPERDRIVE_ID given, do NOT recreate (the live config is
  // 84ab72d4...). Still run the idempotent sql_mode relax, then VERIFY the config
  // exists and emit it.
  if (provider === 'azure' && io.env.HYPERDRIVE_ID) {
    await azureRelax(io);
    const existing = await getHyperdriveConfig(ctx, io.env.HYPERDRIVE_ID);
    io.log(`azure: reusing existing Hyperdrive config ${existing.id} (not recreated)`);
    return finish(io, { provider, hyperdrive_id: existing.id, sql_mode: sqlMode, host: existing.origin && existing.origin.host, database: existing.origin && existing.origin.database, user: existing.origin && existing.origin.user, note: 'reused existing Azure config; server sql_mode relaxed', reused: true });
  }

  const resolver = provider === 'vultr' ? (x) => resolveVultr(x, name) : RESOLVERS[provider];
  const { origin, host, database, user, note } = await resolver(io);
  const cfg = await createHyperdriveConfig(ctx, { name, origin });
  io.log(`hyperdrive: created config ${cfg.id} (caching disabled) for ${provider}`);
  return finish(io, { provider, hyperdrive_id: cfg.id, sql_mode: sqlMode, host, database, user, note, reused: false });
}

// Emit the contract. Optionally write an env file (HYPERDRIVE_ID, SQL_MODE) for
// Phase 2 to source. The file holds only the config id and the mode string, no
// secret; written 0600 anyway.
async function finish(io, result) {
  if (io.out) {
    await writeFile(io.out, `HYPERDRIVE_ID=${result.hyperdrive_id}\nSQL_MODE=${result.sql_mode}\n`, { mode: 0o600 });
    io.log(`wrote ${io.out} (HYPERDRIVE_ID, SQL_MODE)`);
  }
  return result;
}

async function main() {
  const { provider, opts } = parseArgs(process.argv.slice(2));
  const env = process.env;
  const here = dirname(fileURLToPath(import.meta.url));
  const io = {
    env, run: makeRunner(), fetchImpl: fetch, log: (m) => console.error(m),
    acct: env.CLOUDFLARE_ACCOUNT_ID || env.ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN,
    name: opts.name || env.ONBOARD_NAME, out: opts.out || env.ONBOARD_OUT, dryRun: Boolean(opts.dryRun),
    mysqlTfDir: join(here, '..', 'mysql'),
  };
  const result = await onboard(provider, io);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('error:', e.message); process.exit(1); });
}
