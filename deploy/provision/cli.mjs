#!/usr/bin/env node
// site CLI over the provisioning core (#154): site add --kind wp|shop <name>.
// Thin: parse args, assemble config from env + the PRE-BUILT worker bundle on
// disk, generate per-site secrets, then call provisionSite. The orchestration
// is in provision.mjs, so the provisioning Worker shares it. The worker bundle
// and the c1 image are prerequisite artifacts built once (wrangler/esbuild and
// wrangler containers push); the core never builds either at provision time.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { provisionSite } from './provision.mjs';
import { SITE_NAME_RE, isCallerReservedName, genSecret } from './shared.mjs';
import { bDosqlBindings, mediaBucketName } from './wp-site-config.mjs';

// genSecret lives in shared.mjs (the Worker uses it too); re-export so the CLI
// surface and cli-test are unchanged.
export { genSecret };

// Pure, so it is unit-tested without IO.
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!['add', 'remove', 'list'].includes(cmd)) {
    throw new Error('usage: site add|remove|list --kind wp|shop <name>');
  }
  let kind, name;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--kind') kind = rest[++i];
    else if (!rest[i].startsWith('--')) name = rest[i];
  }
  if (cmd === 'add') {
    if (!['wp', 'shop'].includes(kind)) throw new Error('add needs --kind wp|shop');
    if (!name || !SITE_NAME_RE.test(name)) throw new Error('add needs a valid <name> (lower case, digits, hyphens, 1 to 30)');
    if (isCallerReservedName(name)) throw new Error('<name> is reserved (an infrastructure, service, or demo-lane label); pick another');
  }
  return { cmd, kind, name };
}

// Load a PRE-BUILT bundle dir as module parts. A real bundle is not only JS:
// b-dosql ships a PHP .wasm and .zip data blobs, which must upload with their
// own module type and as BINARY (reading them as utf8 corrupts them). Source
// maps and READMEs are not modules. (Loading only .js was a CLI gap, #158.)
function moduleType(f) {
  if (f.endsWith('.js') || f.endsWith('.mjs')) return 'application/javascript+module';
  if (f.endsWith('.wasm')) return 'application/wasm';
  return 'application/octet-stream';
}
async function loadModules(dir) {
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

async function buildCfg(kind, name, env) {
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
  if (!env.C1_IMAGE_REF) throw new Error('set C1_IMAGE_REF (the pushed image digest ref)');
  return {
    ...common, kind: 'shop', mainModule: env.C1_MAIN || 'worker.js',
    hostname: env.SHOP_HOSTNAME || `c1-${name}.${sub}.workers.dev`,
    modules: await loadModules(env.C1_BUNDLE_DIR),
    resourceBindings: JSON.parse(env.SHOP_BINDINGS || '[]'),
    secrets: { WP_SALT: genSecret(), ADMIN_PASSWORD: genSecret(16), SPIKE_TOKEN: genSecret(24) },
    buckets: { db: `wp-woo-${name}-db`, media: `wp-woo-${name}-media` },
    imageRef: env.C1_IMAGE_REF, containerClass: 'Store', instanceType: env.C1_INSTANCE || 'basic',
  };
}

async function main() {
  const { cmd, kind, name } = parseArgs(process.argv.slice(2));
  if (cmd !== 'add') throw new Error(`${cmd}: stage 2 implements add only`);
  const env = process.env;
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) throw new Error('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  const ctx = { acct: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN };
  const cfg = await buildCfg(kind, name, env);
  const r = await provisionSite(ctx, cfg);
  console.log(JSON.stringify({ provisioned: r.kind, name: r.name, script: r.script, hostname: r.hostname }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('error:', e.message); process.exit(1); });
}
