// The ONE source for what a b-dosql WordPress site must bind (#182 config gap).
// deploy/wfp/lib.sh render_user is the authoritative generator for a b-dosql
// namespace site; provisionSite deploys the SAME kind of site, so it must carry
// the SAME bindings and vars or a minted site does not run. Before this, the
// provisioning path deployed resourceBindings:[] and no vars, so a site was
// missing MEDIA, IMAGES, PHP_RUNTIME, EMAIL and every runtime var.
//
// This module emits the FACTS (the API bindings array) so the Worker and the
// CLI consume one source and cannot drift from each other. The var VALUES and
// the binding set are asserted against lib.sh's render_user and against
// deploy/wfp/bindings.py's allowlist in wp-site-config-test.mjs, so a change to
// the authoritative generator that is not mirrored here fails CI without a deploy.
//
// NOT emitted here (not bindings, so not script-metadata): [assets]
// (build/public static files, uploaded via the assets API), and [cache] /
// [exports.Pages.cache] (the page-cache feature). Those are a separate deploy
// concern tracked for the box-gate; see HARDENING.md.

import { genSecret } from './shared.mjs';
import { createKvNamespace, createQueue } from './ops.mjs';

// ---- b-dosql integration-descriptor table (#201 Phase 1) --------------------
// The provisioning core builds a b-dosql site's bindings, vars and generated
// secrets from a TABLE of integration descriptors, not a hand-edited inline
// array. The proven Cloudflare integrations (#201) each land as a binding,
// secret or backing resource added to the SAME b-dosql site, so one inline array
// is a merge chokepoint: every integration edits the one list. A descriptor
// isolates each integration to its own table entry and a reducer assembles the
// final set, so parallel integrations compose without colliding.
//
// A descriptor:
//   name              stable id; also the key used to opt a non-default one in.
//   default           true  = always on for every b-dosql site.
//                     false = opt-in; included only when opts.enable names it.
//   vars(opts)        -> an ORDERED { NAME: text } of plain_text vars (or none).
//                        Insertion order is preserved into the emitted array, so
//                        the default site stays byte-identical to the old inline
//                        order (asserted in descriptor-table-test / wp-site-config-test).
//   bindings(opts)    -> an array of non-var bindings (images/r2/do/..., or none).
//   secretGenerators  { NAME: () => value } per-site generated secrets. The
//                     reducer collects the generators; the CLI evaluates them
//                     into the secrets literal, so a new secret appends cleanly
//                     instead of editing one hand-written object.
//   secrets(opts)     -> { NAME: value } SUPPLIED (externally minted) secrets, for
//                        a credential that is NOT random: the shared platform purge
//                        token (zone-purge). Unlike secretGenerators (per-site
//                        random), the value comes from opts and the descriptor only
//                        DECLARES it; the lead mints the token, provisioning wires
//                        it in. Called only when the descriptor is enabled.
//   resourceCreateOp(ctx, { cfg, bindings })
//                     optional async op run at provision time BEFORE the script
//                     deploys, for an integration that needs a backing resource
//                     (a KV namespace, a queue). It may inject the created id into
//                     its own binding in bindings, exactly as the OC_KV namespace
//                     injection does. No default descriptor has one; the L2 KV
//                     (#218) and Queue (#190) waves add theirs here.

// The always-on b-dosql runtime vars, in the EXACT order lib.sh render_user
// emits them so bDosqlVars stays byte-identical:
//   PHP_ENV      the PHP allocator setting (USE_ZEND_ALLOC off)
//   SITE_ORIGIN  the site's own origin (issue #33): WP_HOME and every link
//   PHP_IN_DO    PHP runs in the Durable Object
//   PHP_LOCATION the object's location hint
//   PHP_DO_POOL  the object pool size
//   DB_IN_DO     the database is the object's own SQLite (b-dosql)
// PHP_IN_DO=on + DB_IN_DO=on + the MEDIA binding are also the PRECONDITIONS that
// turn on the default-on gates in index.js (object cache, route cache, theme.json
// cache, async email, bootstrap trim, media-write trim): index.js enables each
// unless its var is "off", so the site gets them with no gate var set.
function bDosqlRuntimeVars({ siteOrigin, location = 'enam', cronIntervalMs, mailFrom, mailFromName } = {}) {
  if (!siteOrigin) throw new Error('bDosqlVars: siteOrigin is required (the site WP_HOME origin, issue #33)');
  const vars = {
    PHP_ENV: '{"USE_ZEND_ALLOC":"0"}',
    SITE_ORIGIN: siteOrigin,
    PHP_IN_DO: 'on',
    PHP_LOCATION: location,
    PHP_DO_POOL: '1',
    DB_IN_DO: 'on',
  };
  // Optional, matching deploy.sh's optional emit (the DO alarm cadence, #185);
  // omitted by default, exactly as render_user omits it (index.js defaults 60000).
  if (cronIntervalMs !== undefined && cronIntervalMs !== null && cronIntervalMs !== '') {
    vars.CRON_INTERVAL_MS = String(cronIntervalMs);
  }
  // MAIL_FROM (#186): a SaaS site at <name>.<base> must send from the onboarded
  // BASE domain (wordpress@<base>), NOT its own subdomain, which is not onboarded
  // for Cloudflare Email Sending and would be rejected. The site name is the
  // display name so each store is distinguishable. Unset -> the site's
  // mail-from.mjs falls back to its own host (which only sends if that host is
  // itself onboarded, e.g. a bring-your-own-domain tenant).
  if (mailFrom) {
    vars.MAIL_FROM = mailFrom;
    if (mailFromName) vars.MAIL_FROM_NAME = mailFromName;
  }
  return vars;
}

// The b-dosql descriptor table. The five always-on entries ARE the old inline
// set (the runtime vars, IMAGES, the site MEDIA bucket, the PHP_RUNTIME DO, and
// EMAIL), in the order the old bDosqlBindings emitted them, so the default site
// is byte-identical. PDF invoices is the reference OPT-IN entry.
export const B_DOSQL_DESCRIPTORS = [
  { name: 'runtime', default: true, vars: bDosqlRuntimeVars },
  { name: 'images', default: true, bindings: () => [{ type: 'images', name: 'IMAGES' }] },
  { name: 'media', default: true, bindings: ({ mediaBucket }) => [{ type: 'r2_bucket', name: 'MEDIA', bucket_name: mediaBucket }] },
  { name: 'php-runtime', default: true, bindings: () => [{ type: 'durable_object_namespace', name: 'PHP_RUNTIME', class_name: 'PhpRuntime' }] },
  { name: 'email', default: true, bindings: () => [{ type: 'send_email', name: 'EMAIL' }] },
  // PDF order invoices (#227/#228), the reference OPT-IN descriptor: the Browser
  // Rendering binding plus the INVOICE_TOKEN download-signing secret. index.js
  // pdfInvoiceEnabled() turns the feature on whenever env.BROWSER is present (and
  // PDF_INVOICE != off), so provisioning the binding IS the whole switch: no gate
  // var and no drop-in change. Opt-in (metered), so default:false keeps every
  // other site byte-identical. NOTE: the WFP allowlist (deploy/wfp/bindings.py
  // USER_OK) does not yet list "browser"; the provisioning core deploys with the
  // account token and is unaffected, but a WFP lib.sh deploy of a PDF site needs
  // that entry added first (out of this lane's scope; flagged on the PR).
  {
    name: 'pdf-invoices', default: false,
    bindings: () => [{ type: 'browser', name: 'BROWSER' }],
    secretGenerators: { INVOICE_TOKEN: () => genSecret(24) },
  },
  // Zone edge-cache purge-on-publish (#205/#256, the #201 Phase 1 "Edge / zone
  // cache + purge-on-publish" default). Wires the two bindings the zone purge path
  // needs on a ZONED site: PURGE_ZONE (a plain_text var, the zone id the site
  // terminates on) and PURGE_TOKEN (a secret_text, a SHARED platform Cloudflare
  // token scoped to Zone.Cache Purge on the SaaS zone, minted by the lead and
  // SUPPLIED from opts, NOT generated per site). index.js cachePurgeEnabled() turns
  // the feature on when PHP_IN_DO/DB_IN_DO are on and BOTH PURGE_ZONE and
  // PURGE_TOKEN are present (CACHE_PURGE=off turns it off), so provisioning these
  // two bindings IS the whole switch: no drop-in change. Default-OFF: only a site
  // with a zone has a PURGE_ZONE, so the CLI enables this (and supplies
  // purgeZone/purgeToken) only when a zone and the shared token are configured; a
  // zoneless workers.dev site never enables it and stays byte-identical. The guards
  // throw if enabled without either input, so a misconfigured enable fails loudly
  // instead of wiring PURGE_ZONE=undefined.
  {
    name: 'zone-purge', default: false,
    vars: ({ purgeZone }) => {
      if (!purgeZone) throw new Error('zone-purge: purgeZone is required when enabled (the zone id the site terminates on)');
      return { PURGE_ZONE: purgeZone };
    },
    secrets: ({ purgeToken }) => {
      if (!purgeToken) throw new Error('zone-purge: purgeToken is required when enabled (the shared platform Zone.Cache Purge token)');
      return { PURGE_TOKEN: purgeToken };
    },
  },
  // Object-cache L2 (#218), DEFAULT-ON: a per-site KV namespace behind the
  // in-isolate object cache, so a cold b-dosql isolate reads KV instead of
  // recomputing from SQLite. index.js ocL2On() turns L2 on from OBJECT_CACHE_L2=on
  // plus the OC_KV binding (the base object cache is already on via PHP_IN_DO +
  // DB_IN_DO). PER-SITE, not a shared platform namespace: the object-cache key
  // (object-cache-js.php pkey, and index.js ocKvKey) carries NO tenant id, so one
  // shared namespace would cross-serve another site's alloptions. This mirrors
  // approach A's proven per-site OC_KV (wp-wfp-<name>-oc). The resourceCreateOp
  // creates the namespace (idempotent by title) and injects its assigned id into the
  // OC_KV binding, exactly as approach A's kvNamespaces injection does.
  {
    name: 'object-cache-l2', default: true,
    vars: () => ({ OBJECT_CACHE_L2: 'on' }),
    bindings: () => [{ type: 'kv_namespace', name: 'OC_KV' }],
    resourceCreateOp: async (ctx, { cfg, bindings }) => {
      const title = ocKvNamespaceName(cfg.name);
      const ns = await createKvNamespace(ctx, title);
      const binding = bindings.find((b) => b.type === 'kv_namespace' && b.name === 'OC_KV');
      if (!binding) throw new Error('object-cache-l2: no OC_KV kv_namespace binding to inject');
      binding.namespace_id = ns.id;
      return { kvNamespace: title, id: ns.id, created: ns.created === true };
    },
  },
  // Durable async email (#190), OPT-IN (default:false). The per-site queue + DLQ and
  // the EMAIL_QUEUE producer binding are fully wired, but turning the durable path on
  // by default would be a mail-delivery REGRESSION: index.js emailQueueEnabled() routes
  // mail to the queue whenever EMAIL_QUEUE is bound and ASYNC_EMAIL_QUEUE != off, and the
  // push-CONSUMER subscription (queue -> site-<name>, max_retries, dead_letter_queue) is a
  // POST-deploy step this pre-deploy descriptor seam does not perform. So a default-on
  // queue would divert every store's order mail to a queue with NO consumer (enqueued,
  // never delivered), worse than the working v1 DO-alarm path. Default-on is a Phase-2
  // follow-up gated on wiring that consumer (same shape as zone-purge's lead-supplied
  // token). Opt in with WP_ASYNC_EMAIL_QUEUE / ASYNC_EMAIL_QUEUE (cli bDosqlEnabledIntegrations).
  // PER-SITE, not shared: a queue has ONE consumer that delivers through the consuming
  // site's own env.EMAIL / MAIL_FROM identity, so a shared queue cannot route each
  // tenant's mail to the right sender. The resourceCreateOp ensures the per-site queue
  // AND its dead-letter queue (both idempotent by name) and injects queue_name.
  {
    name: 'async-email-queue', default: false,
    vars: () => ({ ASYNC_EMAIL_QUEUE: 'on' }),
    bindings: () => [{ type: 'queue', name: 'EMAIL_QUEUE' }],
    resourceCreateOp: async (ctx, { cfg, bindings }) => {
      const name = emailQueueName(cfg.name);
      const q = await createQueue(ctx, name);
      const dlq = emailDlqName(cfg.name);
      await createQueue(ctx, dlq); // the dead-letter queue the consumer routes to
      const binding = bindings.find((b) => b.type === 'queue' && b.name === 'EMAIL_QUEUE');
      if (!binding) throw new Error('async-email-queue: no EMAIL_QUEUE queue binding to inject');
      binding.queue_name = name;
      return { queue: name, dlq, id: q.id, created: q.created === true };
    },
  },
  // Privacy-friendly pageview analytics (#201 Phase 2), OPT-IN (default:false, a
  // privacy implication). Binds the Analytics Engine dataset (ANALYTICS) and sets
  // WP_ANALYTICS=on, the opt-in signal index.js analyticsEnabled() requires.
  // index.js records one anonymized pageview per front-end request (host, path,
  // status, country; no cookie, no IP, no PII); the index is the site HOST, never
  // a visitor. PER-SITE dataset (analyticsDatasetName -> wp-wfp-<name>-analytics,
  // the wp-wfp- reserved prefix so a tenant can never mint a colliding name), so
  // one site's pageviews never mix with another's and the operator reads only its
  // own. Analytics Engine creates the dataset on first write, so there is NO
  // resourceCreateOp (unlike the L2-KV / Queue waves). The guard throws if enabled
  // without analyticsDataset, so a misconfigured enable fails loudly instead of
  // binding dataset=undefined. Metered, so default:false keeps every other site
  // byte-identical. Opt in with WP_ANALYTICS (cli bDosqlEnabledIntegrations).
  {
    name: 'analytics-engine', default: false,
    vars: () => ({ WP_ANALYTICS: 'on' }),
    bindings: ({ analyticsDataset }) => {
      if (!analyticsDataset) throw new Error('analytics-engine: analyticsDataset is required when enabled (the per-site Analytics Engine dataset name)');
      return [{ type: 'analytics_engine', name: 'ANALYTICS', dataset: analyticsDataset }];
    },
  },
];

// Is a descriptor included for this site? Always-on (default) ones always; an
// opt-in one only when opts.enable lists its name.
function bDosqlDescriptorEnabled(d, enable) {
  return d.default === true || (Array.isArray(enable) && enable.includes(d.name));
}

// The reducer. Walk the enabled descriptors once and gather the parts: vars
// first (descriptor order, then each descriptor's insertion order) then bindings
// (descriptor order), matching the old inline emit; plus the secret generators
// and the provision-time resource ops the enabled descriptors contribute. This
// is the ONE place the table becomes a binding/var/secret set, so an integration
// is added by adding a table entry, never by editing an assembled array.
export function assembleBDosql(opts = {}) {
  const enable = opts.enable;
  const vars = {};
  const bindings = [];
  const secretGenerators = {};
  const suppliedSecrets = {};
  const resourceCreateOps = [];
  for (const d of B_DOSQL_DESCRIPTORS) {
    if (!bDosqlDescriptorEnabled(d, enable)) continue;
    if (d.vars) Object.assign(vars, d.vars(opts) || {});
    if (d.bindings) bindings.push(...(d.bindings(opts) || []));
    if (d.secretGenerators) Object.assign(secretGenerators, d.secretGenerators);
    if (d.secrets) Object.assign(suppliedSecrets, d.secrets(opts) || {});
    if (d.resourceCreateOp) resourceCreateOps.push({ name: d.name, op: d.resourceCreateOp });
  }
  return {
    vars: Object.entries(vars).map(([name, text]) => ({ type: 'plain_text', name, text })),
    bindings,
    secretGenerators,
    suppliedSecrets,
    resourceCreateOps,
  };
}

// The runtime vars a b-dosql site needs, as API plain_text bindings. Values are
// kept byte-identical to lib.sh render_user (the runtime descriptor is the one
// source). bDosqlVars is kept as a named export because the drift guard and the
// CLI consume the var subset on its own.
export function bDosqlVars(opts = {}) {
  return Object.entries(bDosqlRuntimeVars(opts)).map(([name, text]) => ({ type: 'plain_text', name, text }));
}

// The full binding set for a b-dosql namespace site, assembled from the table:
// the runtime vars plus the enabled descriptors' bindings (IMAGES, the site's own
// MEDIA bucket, the PHP_RUNTIME Durable Object, EMAIL, and any opted-in
// integration's bindings). The PhpRuntime migration is declared by provisionSite
// (sqliteClasses), not here. Secrets (WP_SALT, SPIKE_TOKEN, and any descriptor's
// generated secret) are added by the CLI / provisionSite as secret_text bindings.
//
// extra: caller-supplied EXTRA bindings appended after the standard set (the
// CLI's WP_BINDINGS slot). The Worker passes none; the standard set is never
// caller-controlled. enable: opt-in descriptor names (default none), so the
// default set is byte-identical to the old hard-coded array.
export function bDosqlBindings(opts = {}) {
  if (!opts.mediaBucket) throw new Error('bDosqlBindings: mediaBucket is required');
  const { extra = [] } = opts;
  const { vars, bindings } = assembleBDosql(opts);
  return [...vars, ...bindings, ...extra];
}

// The secrets the enabled descriptors contribute, as { NAME: value }: the
// GENERATED ones EVALUATED (each generator called once) plus the SUPPLIED ones
// (values passed through opts, e.g. zone-purge's shared PURGE_TOKEN). The CLI
// spreads these into the secrets literal next to WP_SALT / SPIKE_TOKEN, so an
// opt-in integration's secret (PDF's generated INVOICE_TOKEN, zone-purge's
// supplied PURGE_TOKEN) is added by adding a descriptor, not by editing the
// literal. No DEFAULT descriptor contributes a secret, so the default site's
// secrets are unchanged.
export function bDosqlSecrets(opts = {}) {
  const { secretGenerators, suppliedSecrets } = assembleBDosql(opts);
  const out = {};
  for (const [name, gen] of Object.entries(secretGenerators)) out[name] = gen();
  // SUPPLIED secrets (the shared platform PURGE_TOKEN) are values already, not
  // generators: a descriptor DECLARES them, the lead mints them, the CLI passes
  // them in via opts. They overlay after the generated ones (disjoint names).
  Object.assign(out, suppliedSecrets);
  return out;
}

// The provision-time resource-create ops the enabled descriptors contribute, as
// [{ name, op }]. provisionSite runs each before the script deploys (and lets an
// op inject a created id into its binding). No default descriptor has one today;
// this is the seam the L2 KV (#218) and Queue (#190) waves bind through.
export function bDosqlResourceCreateOps(opts = {}) {
  return assembleBDosql(opts).resourceCreateOps;
}

// The media bucket name for a site, the one name both the binding and the
// bucket-create must agree on (wp-wfp-<name>-media, per bindings.py).
export function mediaBucketName(name) {
  return `wp-wfp-${name}-media`;
}


// ---- Approach A (#218): PHP-WASM in the WORKER, MySQL via Hyperdrive ---------
// The ONE source for what an "approach A" site must bind, mirroring bDosqlVars /
// bDosqlBindings so the CLI and any Worker caller consume one source and cannot
// drift. The authoritative generator for approach A is the b2-wordpress spike's
// wrangler.toml [env.a-paid-lean] (lean MySQL client + object cache L2 + lazy
// nodes + opcache); a-site-config-test.mjs asserts these emits against it.
//
// What makes approach A DIFFERENT from b-dosql, and why the binding set differs:
//   - PHP runs in the WORKER isolate, NOT a Durable Object. So there is NO
//     PHP_RUNTIME durable_object_namespace binding and NO SQLite migration
//     (provisionSite declares none for kind 'a').
//   - The database is EXTERNAL managed MySQL reached through a HYPERDRIVE
//     binding (the config id comes from onboarding). DB_IN_DO / PHP_IN_DO are
//     NOT set (the object's SQLite is not the database here).
//   - The object cache has an L2 in a per-site OC_KV namespace, so a cold
//     isolate reads KV instead of crossing the Hyperdrive hop to MySQL.
// The lean MySQL client (mysql-lean.js) is in the uploaded bundle, set by the
// index-a-lean.js entry; it is code, not a binding.
export function aVars({
  siteOrigin, tablePrefix = 'wp_', hyperdriveSqlMode,
  objectCacheGroups = 'options,terms,theme_json', objectCacheTtl = '10', lazyCacheMb = '4',
  mailFrom, mailFromName,
} = {}) {
  if (!siteOrigin) throw new Error('aVars: siteOrigin is required (the site WP_HOME origin, issue #33)');
  const vars = {
    // PHP_ENV carries BOTH the allocator setting and the WP table prefix (the
    // approach-A install shares the MySQL schema by prefix, #218).
    PHP_ENV: JSON.stringify({ USE_ZEND_ALLOC: '0', WP_TABLE_PREFIX: tablePrefix }),
    SITE_ORIGIN: siteOrigin,
    OBJECT_CACHE: 'on',
    OBJECT_CACHE_GROUPS: objectCacheGroups,
    OBJECT_CACHE_TTL: String(objectCacheTtl),
    OBJECT_CACHE_L2: 'on',
    LAZY_NODES: 'on',
    LAZY_CACHE_MB: String(lazyCacheMb),
  };
  // HYPERDRIVE_SQL_MODE (#218): a per-statement sql_mode relax, REQUIRED only for
  // strict backends (PlanetScale/Vitess, e.g.
  // ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION). index.js emits it into
  // wp-config only when it matches /^[A-Za-z_,]*$/, so reject anything else here
  // rather than ship a value the site will silently drop.
  if (hyperdriveSqlMode !== undefined && hyperdriveSqlMode !== null && hyperdriveSqlMode !== '') {
    if (!/^[A-Za-z_,]*$/.test(hyperdriveSqlMode)) {
      throw new Error(`aVars: HYPERDRIVE_SQL_MODE must match [A-Za-z_,]* (got ${JSON.stringify(hyperdriveSqlMode)})`);
    }
    vars.HYPERDRIVE_SQL_MODE = hyperdriveSqlMode;
  }
  // MAIL_FROM: same rule as b-dosql (#186); a SaaS site sends from the onboarded
  // base domain, not its own subdomain. Optional.
  if (mailFrom) {
    vars.MAIL_FROM = mailFrom;
    if (mailFromName) vars.MAIL_FROM_NAME = mailFromName;
  }
  return Object.entries(vars).map(([name, text]) => ({ type: 'plain_text', name, text }));
}

// The full binding set for an approach-A namespace site: the vars above plus
// IMAGES, the site's own MEDIA bucket, the HYPERDRIVE binding to the given
// config id, the OC_KV object-cache L2 namespace, and the EMAIL send_email
// binding. NO PHP_RUNTIME durable object (PHP runs in the Worker), so NO SQLite
// migration. Secrets (WP_SALT, SPIKE_TOKEN) are added by provisionSite.
//
// ocKvNamespaceId: the per-site OC_KV namespace is CREATED at provision time, so
// its id is not known when the caller builds this set. provisionSite creates the
// namespace (cfg.kvNamespaces) and INJECTS the id into this binding by name, so
// the caller may leave it undefined (the default). mediaBucket and hyperdriveId
// ARE known upfront (the bucket name is derived; the config id comes from
// onboarding), so they are required.
export function aBindings({
  mediaBucket, hyperdriveId, siteOrigin, tablePrefix, hyperdriveSqlMode,
  objectCacheGroups, objectCacheTtl, lazyCacheMb, ocKvNamespaceId, ocKvBinding = 'OC_KV',
  mailFrom, mailFromName, extra = [],
} = {}) {
  if (!mediaBucket) throw new Error('aBindings: mediaBucket is required');
  if (!hyperdriveId) throw new Error('aBindings: hyperdriveId is required (the Hyperdrive config id from onboarding)');
  const ocKv = { type: 'kv_namespace', name: ocKvBinding };
  // The id is injected by provisionSite after the namespace is created; carry it
  // only if the caller already knows it (e.g. a re-provision passing the id).
  if (ocKvNamespaceId) ocKv.namespace_id = ocKvNamespaceId;
  return [
    ...aVars({ siteOrigin, tablePrefix, hyperdriveSqlMode, objectCacheGroups, objectCacheTtl, lazyCacheMb, mailFrom, mailFromName }),
    { type: 'images', name: 'IMAGES' },
    { type: 'r2_bucket', name: 'MEDIA', bucket_name: mediaBucket },
    { type: 'hyperdrive', name: 'HYPERDRIVE', id: hyperdriveId },
    ocKv,
    { type: 'send_email', name: 'EMAIL' },
    ...extra,
  ];
}

// The OC_KV object-cache L2 namespace title for a site, the one name both the
// create and the id lookup agree on (wp-wfp-<name>-oc; the wp-wfp- prefix is in
// RESERVED_PREFIXES so a tenant can never mint a colliding name).
export function ocKvNamespaceName(name) {
  return `wp-wfp-${name}-oc`;
}

// The per-site durable-email queue name (#190) and its dead-letter queue. Both
// carry the wp-wfp- reserved prefix (RESERVED_PREFIXES) so a tenant can never mint
// a colliding name, the same guarantee as ocKvNamespaceName / mediaBucketName.
export function emailQueueName(name) {
  return `wp-wfp-${name}-email`;
}
export function emailDlqName(name) {
  return `wp-wfp-${name}-email-dlq`;
}

// The per-site Analytics Engine dataset name (#201 Phase 2). Carries the wp-wfp-
// reserved prefix (RESERVED_PREFIXES) so a tenant can never mint a colliding name,
// the same guarantee as mediaBucketName / ocKvNamespaceName / emailQueueName.
// Analytics Engine creates the dataset on first write, so there is no create step;
// the name is only the binding's dataset field and the SQL table the operator
// queries. It is NOT a plain SQL identifier (it has hyphens), so the operator read
// query double-quotes it (docs/operator.md).
export function analyticsDatasetName(name) {
  return `wp-wfp-${name}-analytics`;
}
