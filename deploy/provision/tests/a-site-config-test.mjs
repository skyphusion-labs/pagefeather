// Drift guard (#241): the provisioning path for an "approach A" site (#218) must
// deploy the SAME binding + var set as the authoritative generator, which for
// approach A is the b2-wordpress spike's wrangler.toml [env.a-paid-lean] (lean
// MySQL client, object cache + L2 KV, lazy nodes, opcache). This test reads that
// block and checks the shared wp-site-config.mjs (aVars / aBindings) against it,
// so a change to the spike that is not mirrored here fails CI WITHOUT a live
// deploy. It is the approach-A parallel of wp-site-config-test.mjs (b-dosql vs
// lib.sh render_user).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { aVars, aBindings, mediaBucketName, ocKvNamespaceName } from '../wp-site-config.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// The authoritative approach-A env: the [env.a-paid-lean] block of the spike
// wrangler, sliced to the next env table.
const here = dirname(fileURLToPath(import.meta.url));
const toml = readFileSync(join(here, '../../../spikes/b2-wordpress/wrangler.toml'), 'utf8');
const start = toml.indexOf('[env.a-paid-lean]');
const end = toml.indexOf('[env.a-paid-do-lean]');
const aLean = start >= 0 && end > start ? toml.slice(start, end) : '';
ok('the [env.a-paid-lean] block was found in the spike wrangler (the instrument can read its source)', aLean.length > 0);

const b = aBindings({ mediaBucket: mediaBucketName('alean'), hyperdriveId: 'HDID', siteOrigin: 'https://alean.skyphusionwp.dev' });
const byType = (t) => b.filter((x) => x.type === t);
const varOf = (n) => byType('plain_text').find((x) => x.name === n);

// 1. The static approach-A vars match [env.a-paid-lean] byte for byte (the values
// that are not per-site). SITE_ORIGIN is per-site, so only its presence is checked.
ok('PHP_ENV carries USE_ZEND_ALLOC off AND the WP table prefix, matching a-paid-lean',
  varOf('PHP_ENV').text === '{"USE_ZEND_ALLOC":"0","WP_TABLE_PREFIX":"wp_"}' &&
  aLean.includes('PHP_ENV = \'{"USE_ZEND_ALLOC":"0","WP_TABLE_PREFIX":"wp_"}\''));
ok('OBJECT_CACHE = on matches a-paid-lean', varOf('OBJECT_CACHE').text === 'on' && aLean.includes('OBJECT_CACHE = "on"'));
ok('OBJECT_CACHE_GROUPS matches a-paid-lean', varOf('OBJECT_CACHE_GROUPS').text === 'options,terms,theme_json' && aLean.includes('OBJECT_CACHE_GROUPS = "options,terms,theme_json"'));
ok('OBJECT_CACHE_TTL matches a-paid-lean', varOf('OBJECT_CACHE_TTL').text === '10' && aLean.includes('OBJECT_CACHE_TTL = "10"'));
ok('OBJECT_CACHE_L2 = on matches a-paid-lean', varOf('OBJECT_CACHE_L2').text === 'on' && aLean.includes('OBJECT_CACHE_L2 = "on"'));
ok('LAZY_NODES = on matches a-paid-lean', varOf('LAZY_NODES').text === 'on' && aLean.includes('LAZY_NODES = "on"'));
ok('LAZY_CACHE_MB matches a-paid-lean', varOf('LAZY_CACHE_MB').text === '4' && aLean.includes('LAZY_CACHE_MB = "4"'));
ok('SITE_ORIGIN is emitted (WP_HOME correctness, issue #33)', !!varOf('SITE_ORIGIN'));

// 2. The resource bindings match a-paid-lean.
ok('HYPERDRIVE binding is emitted with the given config id ([[hyperdrive]] binding = "HYPERDRIVE")',
  byType('hyperdrive').some((x) => x.name === 'HYPERDRIVE' && x.id === 'HDID') && /binding = "HYPERDRIVE"/.test(aLean));
ok('MEDIA r2_bucket is the site own bucket wp-wfp-<name>-media',
  byType('r2_bucket').some((x) => x.name === 'MEDIA' && x.bucket_name === 'wp-wfp-alean-media') && aLean.includes('binding = "MEDIA"'));
ok('IMAGES binding matches a-paid-lean ([images] binding = "IMAGES")',
  byType('images').some((x) => x.name === 'IMAGES') && /\[env\.a-paid-lean\.images\]\s*\n\s*binding = "IMAGES"/.test(aLean));
ok('OC_KV kv_namespace is emitted (the object-cache L2 store)',
  byType('kv_namespace').some((x) => x.name === 'OC_KV') && aLean.includes('binding = "OC_KV"'));
ok('EMAIL send_email is emitted', byType('send_email').some((x) => x.name === 'EMAIL') && aLean.includes('send_email'));

// 3. The DEFINING difference from b-dosql: approach A runs PHP in the WORKER, so
// there is NO Durable Object and NO SQLite database var. These negatives are the
// whole reason kind 'a' needs its own binding set.
ok('approach A binds NO PHP_RUNTIME durable object (PHP runs in the Worker)', byType('durable_object_namespace').length === 0);
ok('approach A sets NO PHP_IN_DO var (not the DO engine)', !varOf('PHP_IN_DO'));
ok('approach A sets NO DB_IN_DO var (the database is external MySQL, not the object SQLite)', !varOf('DB_IN_DO'));
ok('a-paid-lean itself declares no PHP_IN_DO / DB_IN_DO (so the negatives above are faithful to the source)',
  !aLean.includes('PHP_IN_DO = ') && !aLean.includes('DB_IN_DO = '));

// 4. HYPERDRIVE_SQL_MODE: omitted by default (non-strict backend, e.g. Azure
// MySQL), carried only when the strict-backend flag is supplied, and validated.
ok('HYPERDRIVE_SQL_MODE omitted by default', !aVars({ siteOrigin: 'https://x' }).some((v) => v.name === 'HYPERDRIVE_SQL_MODE'));
ok('HYPERDRIVE_SQL_MODE carried when set (strict backend)',
  aVars({ siteOrigin: 'https://x', hyperdriveSqlMode: 'ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION' })
    .some((v) => v.name === 'HYPERDRIVE_SQL_MODE' && v.text === 'ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'));
ok('HYPERDRIVE_SQL_MODE rejects a value outside index.js charset [A-Za-z_,]* (injection guard)',
  throws(() => aVars({ siteOrigin: 'https://x', hyperdriveSqlMode: 'DROP TABLE x; --' })));

// 5. Required inputs: the two pieces that are NOT derivable (the Hyperdrive config
// id from onboarding, and the media bucket) are required; siteOrigin is required
// in aVars; MAIL_FROM is optional.
ok('aVars requires siteOrigin', throws(() => aVars({})));
ok('aBindings requires mediaBucket', throws(() => aBindings({ hyperdriveId: 'HDID', siteOrigin: 'https://x' })));
ok('aBindings requires hyperdriveId (the onboarding config id)', throws(() => aBindings({ mediaBucket: 'm', siteOrigin: 'https://x' })));
ok('MAIL_FROM omitted by default', !aVars({ siteOrigin: 'https://x' }).some((v) => v.name === 'MAIL_FROM'));
ok('MAIL_FROM set to the base sender when provided (the #186 rule, approach A too)',
  aVars({ siteOrigin: 'https://x', mailFrom: 'wordpress@skyphusionwp.dev', mailFromName: 'alean' })
    .some((v) => v.name === 'MAIL_FROM' && v.text === 'wordpress@skyphusionwp.dev'));

// 6. OC_KV namespace title is the one name the create and the id lookup share.
ok('ocKvNamespaceName is wp-wfp-<name>-oc (the reserved wp-wfp- prefix)', ocKvNamespaceName('alean') === 'wp-wfp-alean-oc');

// 7. The OC_KV binding carries no namespace_id by default (the core injects it
// after creating the namespace), but accepts one on a re-provision.
ok('OC_KV binding has NO namespace_id by default (injected by the core)',
  !byType('kv_namespace').find((x) => x.name === 'OC_KV').namespace_id);
ok('OC_KV binding carries namespace_id when the caller already knows it',
  aBindings({ mediaBucket: 'm', hyperdriveId: 'HDID', siteOrigin: 'https://x', ocKvNamespaceId: 'OCKVID' })
    .some((x) => x.type === 'kv_namespace' && x.name === 'OC_KV' && x.namespace_id === 'OCKVID'));

// 8. Negative control: the instrument can FAIL. A var the spike does NOT carry is
// absent, so the exact-match checks above are discriminating.
ok('negative control: a-paid-lean does not carry a bogus var name', !aLean.includes('NOT_A_REAL_VAR ='));
ok('negative control: a-paid-lean does not set OBJECT_CACHE = off', !aLean.includes('OBJECT_CACHE = "off"'));

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
