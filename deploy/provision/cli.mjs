#!/usr/bin/env node
// site CLI over the provisioning core (#154): site add --kind wp|a <name>.
// The c1 'shop' store path was retired (#214); a store is a b-dosql site.
// kind 'a' is approach A (#218/#241): PHP-WASM in the WORKER with managed MySQL
// through a Hyperdrive binding (the config id comes from onboarding, passed as
// --hyperdrive). Thin: parse args, assemble config from env + the PRE-BUILT
// worker bundle on disk, generate per-site secrets, then call provisionSite. The
// orchestration is in provision.mjs, so the provisioning Worker shares it. The
// worker bundle is a prerequisite artifact built once (ENGINE=<kind> ./build.sh);
// the core never builds it at provision time.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { provisionSite } from './provision.mjs';
import { SITE_NAME_RE, isCallerReservedName, genSecret } from './shared.mjs';
import { bDosqlBindings, aBindings, mediaBucketName, ocKvNamespaceName } from './wp-site-config.mjs';

// genSecret lives in shared.mjs (the Worker uses it too); re-export so the CLI
// surface and cli-test are unchanged.
export { genSecret };

// Pure, so it is unit-tested without IO.
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!['add', 'remove', 'list'].includes(cmd)) {
    throw new Error('usage: site add|remove|list --kind wp|a <name> [--hyperdrive <id>] [--hyperdrive-sql-mode <mode>]');
  }
  let kind, name, hyperdrive, hyperdriveSqlMode;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--kind') kind = rest[++i];
    else if (a === '--hyperdrive') hyperdrive = rest[++i];
    else if (a === '--hyperdrive-sql-mode') hyperdriveSqlMode = rest[++i];
    else if (!a.startsWith('--')) name = a;
    else throw new Error(`unknown flag ${a}`);
  }
  if (cmd === 'add') {
    // c1 'shop' store path retired (#214): a store is a b-dosql site, kind wp.
    if (kind === 'shop' || kind === 'store') throw new Error('the c1 store path was retired (#214); a store is a b-dosql site, use --kind wp');
    if (kind !== 'wp' && kind !== 'a') throw new Error('add needs --kind wp (b-dosql) or --kind a (approach A)');
    if (!name || !SITE_NAME_RE.test(name)) throw new Error('add needs a valid <name> (lower case, digits, hyphens, 1 to 30)');
    if (isCallerReservedName(name)) throw new Error('<name> is reserved (an infrastructure, service, or demo-lane label); pick another');
    // Approach A reaches MySQL through a Hyperdrive binding; its config id comes
    // from the onboarding step (Phase 1) and is REQUIRED.
    if (kind === 'a' && !hyperdrive) throw new Error('add --kind a needs --hyperdrive <HYPERDRIVE_ID> (the Hyperdrive config id from onboarding)');
    // HYPERDRIVE_SQL_MODE, when given, must be the charset index.js will emit
    // (a per-statement sql_mode relax for strict backends; fail early on a typo).
    if (hyperdriveSqlMode !== undefined && !/^[A-Za-z_,]*$/.test(hyperdriveSqlMode)) throw new Error('--hyperdrive-sql-mode must match [A-Za-z_,]* (e.g. ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION)');
  }
  return { cmd, kind, name, hyperdrive, hyperdriveSqlMode };
}

// Load a PRE-BUILT bundle dir as module parts. A real bundle is not only JS:
// b-dosql and approach A both ship a PHP .wasm and .zip data blobs, which must
// upload with their own module type and as BINARY (reading them as utf8 corrupts
// them). Source maps and READMEs are not modules. (Loading only .js was a CLI
// gap, #158.)
function moduleType(f) {
  if (f.endsWith('.js') || f.endsWith('.mjs')) return 'application/javascript+module';
  if (f.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}
async function loadModules(dir) {
  if (!dir) throw new Error('no bundle dir set (BDOSQL_BUNDLE_DIR for kind wp, A_BUNDLE_DIR for kind a)');
  const files = (await readdir(dir)).filter((f) => !f.endsWith('.map') && f !== 'README.md' && /\.(m?js|wasm|zip|bin|dat|data)$/.test(f));
  const mods = [];
  for (const f of files) {
    const type = moduleType(f);
    const text = type === 'application/javascript+module';
    mods.push({ name: f, content: await readFile(join(dir, f), text ? 'utf8' : undefined), type });
  }
  if (!mods.length) throw new Error(`no module files in bundle dir ${dir}`);
  return mods;
}

async function buildCfg(parsed, env) {
  const { kind, name } = parsed;
  const namespace = env.WFP_NAMESPACE || 'wp-wfp';
  const kvId = env.WFP_KV_ID;
  const sub = env.WFP_SUBDOMAIN;
  const compatibilityDate = env.WFP_COMPAT || '2026-07-01';
  if (!kvId) throw new Error('set WFP_KV_ID (the wp-wfp-sites map id)');
  const common = { name, namespace, kvId, compatibilityDate, compatibilityFlags: ['nodejs_compat'] };
  if (kind === 'wp') {
    const mediaBucket = mediaBucketName(name);
    const hostname = env.WP_HOSTNAME || `wp-${name}.${sub}.workers.dev`;
    return {
      ...common, kind: 'wp', mainModule: env.WP_MAIN || 'index.js',
      hostname,
      modules: await loadModules(env.BDOSQL_BUNDLE_DIR),
      // The FULL b-dosql binding + var set from the ONE shared source (the same
      // the provisioning Worker uses), so the CLI and the Worker cannot drift on
      // what a b-dosql site needs. WP_BINDINGS is the EXTRA-bindings slot,
      // appended after the standard set.
      resourceBindings: bDosqlBindings({
        mediaBucket,
        siteOrigin: env.SITE_ORIGIN || `https://${hostname}`,
        location: env.PHP_LOCATION || 'enam',
        cronIntervalMs: env.CRON_INTERVAL_MS,
        extra: JSON.parse(env.WP_BINDINGS || '[]'),
      }),
      // The b-dosql bundle defines the PhpRuntime SQLite DO; declaring it in a
      // migration is mandatory (API 10061 otherwise, #158).
      sqliteClasses: JSON.parse(env.WP_SQLITE_CLASSES || '["PhpRuntime"]'),
      // Optional: the SaaS zone whose */* dispatcher serves the site. When set,
      // the core places the routing record so the site is reachable with no
      // operator step.
      saasZoneId: env.WFP_SAAS_ZONE_ID || undefined,
      secrets: { WP_SALT: genSecret(), SPIKE_TOKEN: genSecret(24) },
      buckets: { media: mediaBucket },
    };
  }
  if (kind === 'a') {
    // Approach A (#218/#241): PHP-WASM in the WORKER, managed MySQL via a
    // Hyperdrive binding. The entry is index-a-lean.js (it imports index.js and
    // sets the lean MySQL client); the bundle is built with ENGINE=a WOO=1.
    const mediaBucket = mediaBucketName(name);
    const hostname = env.WP_HOSTNAME || `wp-${name}.${sub}.workers.dev`;
    return {
      ...common, kind: 'a', mainModule: env.A_MAIN || 'index-a-lean.js',
      hostname,
      modules: await loadModules(env.A_BUNDLE_DIR),
      // The FULL approach-A binding + var set from the ONE shared source, so the
      // CLI and any Worker caller cannot drift. The Hyperdrive config id is the
      // one piece that comes from onboarding (--hyperdrive); the OC_KV namespace
      // id is injected by the core after it creates the namespace.
      resourceBindings: aBindings({
        mediaBucket,
        hyperdriveId: parsed.hyperdrive,
        siteOrigin: env.SITE_ORIGIN || `https://${hostname}`,
        tablePrefix: env.WP_TABLE_PREFIX || 'wp_',
        hyperdriveSqlMode: parsed.hyperdriveSqlMode || env.HYPERDRIVE_SQL_MODE || undefined,
        mailFrom: env.WP_MAIL_FROM,
        mailFromName: env.WP_MAIL_FROM_NAME,
        extra: JSON.parse(env.WP_BINDINGS || '[]'),
      }),
      // Approach A runs PHP in the WORKER: NO Durable Object, so NO SQLite
      // migration (an empty class list leaves the migration unset in ops).
      sqliteClasses: [],
      // The core CREATES this per-site OC_KV namespace (the object-cache L2) and
      // injects its id into the OC_KV binding by name.
      kvNamespaces: [{ title: ocKvNamespaceName(name), binding: 'OC_KV' }],
      saasZoneId: env.WFP_SAAS_ZONE_ID || undefined,
      secrets: { WP_SALT: genSecret(), SPIKE_TOKEN: genSecret(24) },
      buckets: { media: mediaBucket },
    };
  }
  throw new Error(`buildCfg: only kind 'wp' (b-dosql) and 'a' (approach A) are supported (c1 'shop' store retired #214), got ${kind}`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.cmd !== 'add') throw new Error(`${parsed.cmd}: stage 2 implements add only`);
  const env = process.env;
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) throw new Error('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  const ctx = { acct: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN };
  const cfg = await buildCfg(parsed, env);
  const r = await provisionSite(ctx, cfg);
  console.log(JSON.stringify({ provisioned: r.kind, name: r.name, script: r.script, hostname: r.hostname }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('error:', e.message); process.exit(1); });
}
