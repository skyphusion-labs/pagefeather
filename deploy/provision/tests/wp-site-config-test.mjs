// Drift guard (#182 config gap): the provisioning path must deploy the SAME
// b-dosql binding + var set as the authoritative generator (deploy/wfp/lib.sh
// render_user), using only binding types the WFP allowlist (deploy/wfp/
// bindings.py) permits. This test reads those two files and checks the shared
// wp-site-config.mjs against them, so a change to the generator that is not
// mirrored here fails CI WITHOUT a live deploy.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bDosqlBindings, bDosqlVars, bDosqlSecrets, mediaBucketName } from '../wp-site-config.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

const here = dirname(fileURLToPath(import.meta.url));
const lib = readFileSync(join(here, '../../wfp/lib.sh'), 'utf8');
const bindingsPy = readFileSync(join(here, '../../wfp/bindings.py'), 'utf8');
const deploySh = readFileSync(join(here, '../../deploy.sh'), 'utf8');

const b = bDosqlBindings({ mediaBucket: mediaBucketName('blog'), siteOrigin: 'https://blog.skyphusionwp.dev', location: 'enam' });
const byType = (t) => b.filter((x) => x.type === t);
const varOf = (n) => byType('plain_text').find((x) => x.name === n);

// 1. Every binding TYPE we emit is in the WFP allowlist (bindings.py USER_OK).
const m = /USER_OK = \{([^}]*)\}/.exec(bindingsPy);
const USER_OK = new Set((m ? m[1] : '').match(/"[^"]+"/g).map((s) => s.slice(1, -1)));
ok('every emitted binding type is allowed by bindings.py USER_OK',
  [...new Set(b.map((x) => x.type))].every((t) => USER_OK.has(t)));

// 2. The static vars match lib.sh render_user byte for byte (values that are not
// per-site). SITE_ORIGIN and PHP_LOCATION are per-site, so only their NAME is
// checked against the generator.
ok('PHP_ENV value matches render_user', varOf('PHP_ENV').text === '{"USE_ZEND_ALLOC":"0"}' && lib.includes(`PHP_ENV = '{"USE_ZEND_ALLOC":"0"}'`));
ok('PHP_IN_DO = on matches render_user', varOf('PHP_IN_DO').text === 'on' && lib.includes('PHP_IN_DO = "on"'));
ok('PHP_DO_POOL = 1 matches render_user', varOf('PHP_DO_POOL').text === '1' && lib.includes('PHP_DO_POOL = "1"'));
ok('DB_IN_DO = on matches render_user (b-dosql)', varOf('DB_IN_DO').text === 'on' && lib.includes('DB_IN_DO = "on"'));
ok('SITE_ORIGIN is emitted and present in render_user', varOf('SITE_ORIGIN') && lib.includes('SITE_ORIGIN ='));
ok('PHP_LOCATION is emitted and present in render_user', varOf('PHP_LOCATION') && lib.includes('PHP_LOCATION ='));

// 3. The resource bindings match render_user.
ok('IMAGES binding matches render_user ([images] binding = "IMAGES")',
  byType('images').some((x) => x.name === 'IMAGES') && /\[images\]\s*\n\s*binding = "IMAGES"/.test(lib));
ok('MEDIA r2_bucket is the site own bucket wp-wfp-<name>-media',
  byType('r2_bucket').some((x) => x.name === 'MEDIA' && x.bucket_name === 'wp-wfp-blog-media') && lib.includes('binding = "MEDIA"'));
ok('PHP_RUNTIME durable object = PhpRuntime matches render_user',
  byType('durable_object_namespace').some((x) => x.name === 'PHP_RUNTIME' && x.class_name === 'PhpRuntime') &&
  lib.includes('name = "PHP_RUNTIME"') && lib.includes('class_name = "PhpRuntime"'));

// 4. EMAIL: we ADD send_email (index.js uses env.EMAIL; deploy.sh emits it; it is
// in USER_OK). NOTE a real discrepancy: lib.sh render_user does NOT emit
// send_email, so a WFP site deployed by lib.sh today has no email. Our config
// closes that, and lib.sh should follow. The guard asserts EMAIL is sanctioned
// (allowed + in deploy.sh), not that render_user has it.
ok('EMAIL send_email is emitted', byType('send_email').some((x) => x.name === 'EMAIL'));
ok('send_email is an allowed binding type (USER_OK) and deploy.sh emits it',
  USER_OK.has('send_email') && deploySh.includes('mail-from.mjs') && deploySh.includes('--binding'));
ok('KNOWN GAP recorded: lib.sh render_user omits send_email (WFP sites lack email today)',
  !lib.includes('send_email'));

// 5. The instrument can FAIL: a value we do NOT emit, and a name that is not a
// var, are both absent, so the exact-match checks above are discriminating.
ok('negative control: render_user does not carry PHP_IN_DO = "off"', !lib.includes('PHP_IN_DO = "off"'));
ok('negative control: a bogus var name is not in render_user', !lib.includes('NOT_A_REAL_VAR ='));

// 6. bDosqlVars validates its required input.
let threw = false;
try { bDosqlVars({}); } catch { threw = true; }
ok('bDosqlVars requires siteOrigin', threw);
// Optional CRON_INTERVAL_MS appears only when provided, matching the optional emit.
ok('CRON_INTERVAL_MS omitted by default', !bDosqlVars({ siteOrigin: 'https://x' }).some((v) => v.name === 'CRON_INTERVAL_MS'));
ok('CRON_INTERVAL_MS included when set', bDosqlVars({ siteOrigin: 'https://x', cronIntervalMs: 30000 }).some((v) => v.name === 'CRON_INTERVAL_MS' && v.text === '30000'));

// MAIL_FROM (#186): a SaaS site sends from the onboarded base, not its subdomain.
ok('MAIL_FROM omitted by default', !bDosqlVars({ siteOrigin: 'https://x' }).some((v) => v.name === 'MAIL_FROM'));
ok('MAIL_FROM set to the base sender when provided',
  bDosqlVars({ siteOrigin: 'https://shop.skyphusionwp.dev', mailFrom: 'wordpress@skyphusionwp.dev', mailFromName: 'shop' })
    .some((v) => v.name === 'MAIL_FROM' && v.text === 'wordpress@skyphusionwp.dev'));
ok('MAIL_FROM_NAME is the site name when provided',
  bDosqlVars({ siteOrigin: 'https://shop.skyphusionwp.dev', mailFrom: 'wordpress@skyphusionwp.dev', mailFromName: 'shop' })
    .some((v) => v.name === 'MAIL_FROM_NAME' && v.text === 'shop'));
ok('MAIL_FROM_NAME omitted when only mailFrom is set',
  !bDosqlVars({ siteOrigin: 'https://x', mailFrom: 'wordpress@skyphusionwp.dev' }).some((v) => v.name === 'MAIL_FROM_NAME'));

// ---- #201 Phase 1 regression: proven integrations stay wired, PDF opt-in -----
// The descriptor-table refactor must keep the already-default integrations wired.
// 1) Base object cache: index.js turns JS_OBJECT_CACHE on from PHP_IN_DO=on +
//    DB_IN_DO=on (no explicit cache var), so those two vars are the object-cache
//    PRECONDITION and must stay set to 'on'.
ok('object-cache precondition stays wired (PHP_IN_DO=on and DB_IN_DO=on)',
  varOf('PHP_IN_DO').text === 'on' && varOf('DB_IN_DO').text === 'on');
// 2) The DO-alarm cron cadence (#185): CRON_INTERVAL_MS is emitted when set.
const bCron = bDosqlBindings({ mediaBucket: mediaBucketName('blog'), siteOrigin: 'https://blog.skyphusionwp.dev', cronIntervalMs: 45000 });
ok('DO-alarm cron CRON_INTERVAL_MS stays wired when set',
  bCron.some((v) => v.type === 'plain_text' && v.name === 'CRON_INTERVAL_MS' && v.text === '45000'));
// 3) The IMAGES binding (Cloudflare Images offload) stays in the default set.
ok('IMAGES binding stays wired in the default set', byType('images').some((x) => x.name === 'IMAGES'));

// PDF invoices (#227) is the reference OPT-IN descriptor: OFF by default, and when
// enabled it adds the Browser Rendering binding + an INVOICE_TOKEN generated secret.
ok('PDF invoices is OFF by default (no BROWSER binding in the default set)',
  !b.some((x) => x.type === 'browser'));
const bPdf = bDosqlBindings({ mediaBucket: mediaBucketName('shop'), siteOrigin: 'https://shop.skyphusionwp.dev', enable: ['pdf-invoices'] });
ok('PDF descriptor adds the BROWSER (Browser Rendering) binding',
  bPdf.some((x) => x.type === 'browser' && x.name === 'BROWSER'));
ok('PDF descriptor adds an INVOICE_TOKEN generated secret',
  typeof bDosqlSecrets({ mediaBucket: 'm', siteOrigin: 'https://x', enable: ['pdf-invoices'] }).INVOICE_TOKEN === 'string');

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
