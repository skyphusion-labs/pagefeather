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
//
// site hostname (#248): expose the already-built addCustomHostname (ops.mjs) to
// the operator. A tenant brings its own domain through Cloudflare for SaaS in two
// ownership modes: 'delegated' (the customer holds the domain, we write NOTHING
// to their DNS and PRINT the records they add, anti-hostage) and 'managed' (we
// control their zone and place the records). `site hostname status` polls the
// live custom-hostname state. The SaaS zone id and fallback origin come from env
// (WFP_SAAS_ZONE_ID, WFP_SAAS_FALLBACK), matching how the SaaS home is
// configured (zone skyphusionwp.dev, fallback.skyphusionwp.dev).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { provisionSite } from './provision.mjs';
import { SITE_NAME_RE, isCallerReservedName, genSecret } from './shared.mjs';
import { bDosqlBindings, bDosqlSecrets, bDosqlResourceCreateOps, aBindings, mediaBucketName, ocKvNamespaceName } from './wp-site-config.mjs';
import { addCustomHostname, getCustomHostnameStatus } from './ops.mjs';
import { updateSite, readSite } from './registry.mjs';

// genSecret lives in shared.mjs (the Worker uses it too); re-export so the CLI
// surface and cli-test are unchanged.
export { genSecret };

// A customer vanity domain is an FQDN: labels of letters/digits/hyphens (no
// leading or trailing hyphen), at least two labels, a letter-only TLD. It reaches
// the Cloudflare for SaaS create body and the DNS record names, so validate it
// before any API call (fail early on a typo, keep junk out of the request).
export const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

// The site's own hostname: the site-map key the dispatcher routes and the key a
// custom hostname is folded onto. ONE helper so `site add` and `site hostname`
// cannot drift on what a site is keyed by. WP_HOSTNAME overrides (the SaaS home
// sets it to <name>.skyphusionwp.dev); the default is the workers.dev vanity.
export function siteHostname(name, env) {
  return env.WP_HOSTNAME || `wp-${name}.${env.WFP_SUBDOMAIN}.workers.dev`;
}

// Pure, so it is unit-tested without IO.
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'hostname') return parseHostnameArgs(rest);
  if (!['add', 'remove', 'list'].includes(cmd)) {
    throw new Error('usage: site add|remove|list --kind wp|a <name> [--hyperdrive <id>] [--hyperdrive-sql-mode <mode>] | site hostname add <name> --domain <d> --mode delegated|managed [--dcv-delegation] [--cust-zone <id>] | site hostname status <name>');
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

// site hostname add|status (#248). Pure arg parse; the ops call is in
// hostnameCommand.
//   add <name> --domain <d> --mode delegated|managed [--dcv-delegation] [--cust-zone <id>]
//   status <name>
// managed REQUIRES --cust-zone (the zone we control to place the records on);
// delegated REJECTS it (delegated touches no customer DNS, so a cust-zone would
// be a contradiction, fail loudly rather than silently ignore it).
export function parseHostnameArgs(rest) {
  const [sub, ...rr] = rest;
  if (sub !== 'add' && sub !== 'status') {
    throw new Error('usage: site hostname add <name> --domain <d> --mode delegated|managed [--dcv-delegation] [--cust-zone <id>] | site hostname status <name>');
  }
  let name, domain, mode, dcvDelegation = false, custZone;
  for (let i = 0; i < rr.length; i++) {
    const a = rr[i];
    if (a === '--domain') domain = rr[++i];
    else if (a === '--mode') mode = rr[++i];
    else if (a === '--dcv-delegation') dcvDelegation = true;
    else if (a === '--cust-zone') custZone = rr[++i];
    else if (!a.startsWith('--')) name = a;
    else throw new Error(`unknown flag ${a}`);
  }
  if (!name || !SITE_NAME_RE.test(name)) throw new Error('site hostname needs a valid <name> (the tenant site, lower case, digits, hyphens, 1 to 30)');
  if (sub === 'add') {
    if (!domain) throw new Error('site hostname add needs --domain <d> (the customer vanity domain)');
    if (!DOMAIN_RE.test(domain)) throw new Error(`site hostname add: --domain ${JSON.stringify(domain)} is not a valid FQDN`);
    if (mode !== 'delegated' && mode !== 'managed') throw new Error('site hostname add needs --mode delegated|managed');
    if (mode === 'managed' && !custZone) throw new Error('site hostname add --mode managed needs --cust-zone <id> (the zone we control for the customer domain)');
    if (mode === 'delegated' && custZone) throw new Error('--cust-zone is only valid with --mode managed; delegated touches NO customer DNS (anti-hostage)');
  }
  return { cmd: 'hostname', sub, name, domain, mode, dcvDelegation, custZone };
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

// Opt-in b-dosql integrations (#201 Phase 1). Each metered / privacy-cost
// integration is a descriptor with default:false (see wp-site-config.mjs), turned
// on by its own env flag at provision time; unset leaves the site byte-identical
// to the always-on default set. PDF order invoices (#227): WP_PDF_INVOICE set and
// not 'off' provisions the Browser Rendering binding + the INVOICE_TOKEN secret,
// and index.js pdfInvoiceEnabled() then enables the feature with no further gate.
function bDosqlEnabledIntegrations(env) {
  const enable = [];
  if (env.WP_PDF_INVOICE && env.WP_PDF_INVOICE !== 'off') enable.push('pdf-invoices');
  // Zone edge-cache purge-on-publish (#205/#256): default-OFF, turned ON only when
  // the site HAS a zone (WFP_SAAS_ZONE_ID, the zone it terminates on) AND the shared
  // platform purge token (WFP_PURGE_TOKEN) is configured. Both are required because
  // the runtime gate cachePurgeEnabled() needs BOTH PURGE_ZONE and PURGE_TOKEN; a
  // zone with no token (or a token with no zone) would wire dead weight. A zoneless
  // workers.dev site sets no WFP_SAAS_ZONE_ID, so this never enables and the site is
  // byte-identical. CACHE_PURGE=off is the off switch: it suppresses wiring entirely,
  // so the token is never placed on a site whose operator turned the feature off.
  if (env.WFP_SAAS_ZONE_ID && env.WFP_PURGE_TOKEN && env.CACHE_PURGE !== 'off') enable.push('zone-purge');
  // Durable async email via Queues (#190): OPT-IN. The per-site queue + DLQ + EMAIL_QUEUE
  // producer binding are wired, but default-on would divert order mail to a queue whose
  // push-consumer subscription is a Phase-2 post-deploy step; until that lands, enabling by
  // default would enqueue mail no consumer delivers. Opt in with WP_ASYNC_EMAIL_QUEUE (or
  // ASYNC_EMAIL_QUEUE) set and != off.
  const asyncEmail = env.WP_ASYNC_EMAIL_QUEUE || env.ASYNC_EMAIL_QUEUE;
  if (asyncEmail && asyncEmail !== 'off') enable.push('async-email-queue');
  // Workers AI auto alt-text (#203 / #201 Phase 2): OPT-IN (Workers AI is metered).
  // Provisioning the AI binding IS the whole switch: index.js defines SKYPHUSION_AI_ALT
  // when the AI binding is present and AI_ALT != off, the same shape as pdf-invoices'
  // BROWSER. Opt in with WP_AI_ALT_TEXT (or the runtime gate var AI_ALT) set and != off.
  const aiAlt = env.WP_AI_ALT_TEXT || env.AI_ALT;
  if (aiAlt && aiAlt !== 'off') enable.push('ai-alt-text');
  return enable;
}

async function buildCfg(parsed, env) {
  const { kind, name } = parsed;
  const namespace = env.WFP_NAMESPACE || 'wp-wfp';
  const kvId = env.WFP_KV_ID;
  const compatibilityDate = env.WFP_COMPAT || '2026-07-01';
  if (!kvId) throw new Error('set WFP_KV_ID (the wp-wfp-sites map id)');
  const common = { name, namespace, kvId, compatibilityDate, compatibilityFlags: ['nodejs_compat'] };
  if (kind === 'wp') {
    const mediaBucket = mediaBucketName(name);
    const hostname = siteHostname(name, env);
    // The b-dosql integration-descriptor opts (#201 Phase 1): ONE options object
    // feeds the descriptor reducer for bindings, generated secrets and the
    // provision-time resource ops, so an opt-in integration (PDF invoices today;
    // L2 KV, Queue, zone purge next) is turned on by naming its descriptor in
    // `enable`, never by editing an assembled array. WP_BINDINGS is the EXTRA-
    // bindings slot, appended after the standard set.
    const bdosqlOpts = {
      mediaBucket,
      siteOrigin: env.SITE_ORIGIN || `https://${hostname}`,
      location: env.PHP_LOCATION || 'enam',
      cronIntervalMs: env.CRON_INTERVAL_MS,
      extra: JSON.parse(env.WP_BINDINGS || '[]'),
      // Zone edge-cache purge-on-publish (#205/#256): the zone the site terminates
      // on and the SHARED platform Zone.Cache Purge token (minted by the lead). Read
      // only by the zone-purge descriptor, which the enable gate turns on only when
      // both are present; undefined otherwise, so a zoneless site is untouched.
      purgeZone: env.WFP_SAAS_ZONE_ID || undefined,
      purgeToken: env.WFP_PURGE_TOKEN || undefined,
      enable: bDosqlEnabledIntegrations(env),
    };
    return {
      ...common, kind: 'wp', mainModule: env.WP_MAIN || 'index.js',
      hostname,
      modules: await loadModules(env.BDOSQL_BUNDLE_DIR),
      // The FULL b-dosql binding + var set from the ONE shared source (the same
      // the provisioning Worker uses), so the CLI and the Worker cannot drift on
      // what a b-dosql site needs.
      resourceBindings: bDosqlBindings(bdosqlOpts),
      // The b-dosql bundle defines the PhpRuntime SQLite DO; declaring it in a
      // migration is mandatory (API 10061 otherwise, #158).
      sqliteClasses: JSON.parse(env.WP_SQLITE_CLASSES || '["PhpRuntime"]'),
      // Optional: the SaaS zone whose */* dispatcher serves the site. When set,
      // the core places the routing record so the site is reachable with no
      // operator step.
      saasZoneId: env.WFP_SAAS_ZONE_ID || undefined,
      // WP_SALT + SPIKE_TOKEN are always generated; a descriptor's generated
      // secret (PDF's INVOICE_TOKEN) is spread in from the table, so a new
      // integration secret appends here without editing the literal.
      secrets: { WP_SALT: genSecret(), SPIKE_TOKEN: genSecret(24), ...bDosqlSecrets(bdosqlOpts) },
      // Provision-time resource ops the enabled descriptors contribute (a KV
      // namespace or a queue for the next wave); empty for the default + PDF set.
      resourceCreateOps: bDosqlResourceCreateOps(bdosqlOpts),
      buckets: { media: mediaBucket },
    };
  }
  if (kind === 'a') {
    // Approach A (#218/#241): PHP-WASM in the WORKER, managed MySQL via a
    // Hyperdrive binding. The entry is index-a-lean.js (it imports index.js and
    // sets the lean MySQL client); the bundle is built with ENGINE=a WOO=1.
    const mediaBucket = mediaBucketName(name);
    const hostname = siteHostname(name, env);
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

// Derive the registry state label from the live SaaS status: active only when
// both the hostname and its certificate are active, otherwise pending.
export function stateOf(status) {
  return status && status.active ? 'active' : 'pending';
}

// Print the delegated records a customer adds (to stderr, so stdout stays pure
// JSON for a script). printFn is injectable for tests.
function printDelegatedRecords(records, name, printFn) {
  printFn(`\nDelegated: the customer keeps their domain and adds these records (we place NOTHING, anti-hostage):`);
  for (const rec of records) {
    printFn(`  ${rec.kind.toUpperCase().padEnd(5)} ${rec.name}  ->  ${rec.value}    (${rec.note})`);
  }
  printFn(`\nThen: node cli.mjs hostname status ${name}  (until customHostnameState is active).`);
}

// site hostname add|status (#248). Attaches a custom hostname via the already-
// built addCustomHostname, folds the owner + hostname + state into the site's
// registry entry, and for delegated mode PRINTS the exact DNS records the
// customer adds. status polls the live state and persists it. The SaaS zone id +
// fallback origin come from env. Returns the structured result (also logged), so
// a test asserts on the value, not stdout. out/err are injectable for tests.
export async function hostnameCommand(ctx, parsed, env, { out = console.log, err = console.error } = {}) {
  const kvId = env.WFP_KV_ID;
  const saasZoneId = env.WFP_SAAS_ZONE_ID;
  if (!kvId) throw new Error('set WFP_KV_ID (the wp-wfp-sites map id)');
  if (!saasZoneId) throw new Error('set WFP_SAAS_ZONE_ID (the SaaS home zone, e.g. skyphusionwp.dev)');
  const siteKey = siteHostname(parsed.name, env);

  if (parsed.sub === 'add') {
    const fallbackHostname = env.WFP_SAAS_FALLBACK;
    if (!fallbackHostname) throw new Error('set WFP_SAAS_FALLBACK (the SaaS fallback origin, e.g. fallback.skyphusionwp.dev)');
    const r = await addCustomHostname(ctx, {
      saasZoneId, hostname: parsed.domain, fallbackHostname,
      mode: parsed.mode, dcvDelegation: parsed.dcvDelegation, custZoneId: parsed.custZone,
    });
    const state = stateOf(r.status);
    const entry = await updateSite(ctx, { kvId, hostname: siteKey, patch: {
      domainOwner: parsed.mode === 'delegated' ? 'customer' : 'agency',
      customHostname: r.hostname,
      customHostnameId: r.id,
      customHostnameState: state,
    } });
    const result = {
      site: parsed.name, siteKey, mode: r.mode, domain: r.hostname,
      customHostnameId: r.id, customHostnameState: state,
      domainOwner: entry.domainOwner, dcvDelegation: r.dcvDelegation, records: r.records,
    };
    out(JSON.stringify(result, null, 2));
    if (parsed.mode === 'delegated') printDelegatedRecords(r.records, parsed.name, err);
    else err(`\nManaged: records placed on the zone we control (cust-zone ${parsed.custZone}). Poll: node cli.mjs hostname status ${parsed.name}.`);
    return result;
  }

  // status: read the recorded entry, poll the live state, persist and print.
  const cur = await readSite(ctx, { kvId, hostname: siteKey });
  if (!cur || !cur.customHostnameId) {
    throw new Error(`no custom hostname recorded for site ${parsed.name} (${siteKey}); run: site hostname add ${parsed.name} --domain <d> --mode delegated|managed`);
  }
  const status = await getCustomHostnameStatus(ctx, { saasZoneId, id: cur.customHostnameId });
  const state = stateOf(status);
  if (state !== cur.customHostnameState) {
    await updateSite(ctx, { kvId, hostname: siteKey, patch: { customHostnameState: state } });
  }
  const result = {
    site: parsed.name, siteKey, domain: cur.customHostname,
    customHostnameId: cur.customHostnameId, domainOwner: cur.domainOwner,
    customHostnameState: state, hostnameStatus: status.hostname, sslStatus: status.ssl, active: status.active,
  };
  out(JSON.stringify(result, null, 2));
  return result;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const env = process.env;
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) throw new Error('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  const ctx = { acct: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN };
  if (parsed.cmd === 'hostname') { await hostnameCommand(ctx, parsed, env); return; }
  if (parsed.cmd !== 'add') throw new Error(`${parsed.cmd}: stage 2 implements add and hostname only`);
  const cfg = await buildCfg(parsed, env);
  const r = await provisionSite(ctx, cfg);
  console.log(JSON.stringify({ provisioned: r.kind, name: r.name, script: r.script, hostname: r.hostname }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('error:', e.message); process.exit(1); });
}
