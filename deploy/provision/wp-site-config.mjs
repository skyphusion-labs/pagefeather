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

// The runtime vars a b-dosql site needs, as API plain_text bindings. Values are
// kept byte-identical to lib.sh render_user:
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
export function bDosqlVars({ siteOrigin, location = 'enam', cronIntervalMs, mailFrom, mailFromName } = {}) {
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
  return Object.entries(vars).map(([name, text]) => ({ type: 'plain_text', name, text }));
}

// The full binding set for a b-dosql namespace site: the vars above plus the
// three resource bindings (IMAGES, the site's own MEDIA bucket, the PHP_RUNTIME
// Durable Object) and the EMAIL send_email binding. The PhpRuntime migration is
// declared by provisionSite (sqliteClasses), not here. Secrets (WP_SALT,
// SPIKE_TOKEN) are added by provisionSite as secret_text bindings.
//
// extra: caller-supplied EXTRA bindings appended after the standard set (the
// CLI's WP_BINDINGS slot). The Worker passes none; the standard set is never
// caller-controlled.
export function bDosqlBindings({ mediaBucket, siteOrigin, location = 'enam', cronIntervalMs, mailFrom, mailFromName, extra = [] } = {}) {
  if (!mediaBucket) throw new Error('bDosqlBindings: mediaBucket is required');
  return [
    ...bDosqlVars({ siteOrigin, location, cronIntervalMs, mailFrom, mailFromName }),
    { type: 'images', name: 'IMAGES' },
    { type: 'r2_bucket', name: 'MEDIA', bucket_name: mediaBucket },
    { type: 'durable_object_namespace', name: 'PHP_RUNTIME', class_name: 'PhpRuntime' },
    { type: 'send_email', name: 'EMAIL' },
    ...extra,
  ];
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
