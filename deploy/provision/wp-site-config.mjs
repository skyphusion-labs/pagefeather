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
