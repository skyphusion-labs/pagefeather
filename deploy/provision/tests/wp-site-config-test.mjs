// Drift guard (#182 config gap): the provisioning path must deploy the SAME
// b-dosql binding + var set as the authoritative generator (deploy/wfp/lib.sh
// render_user), using only binding types the WFP allowlist (deploy/wfp/
// bindings.py) permits. This test reads those two files and checks the shared
// wp-site-config.mjs against them, so a change to the generator that is not
// mirrored here fails CI WITHOUT a live deploy.
//
// The generator side is read from its RENDERED OUTPUT (render_user run in bash), never from the
// source text of lib.sh (#345): a grep of the source passes when the text is present but the
// behaviour is gone (a commented-out line, a dead branch), and fails to see what render_user
// emits through a helper (mail-from.mjs). bindings.py is still read as text: USER_OK is a data
// table, not behaviour.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bDosqlBindings, bDosqlVars, bDosqlSecrets, mediaBucketName } from '../wp-site-config.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

const here = dirname(fileURLToPath(import.meta.url));
const libPath = join(here, '../../wfp/lib.sh');
// What render_user prints for a site. Same inputs as the provisioning config below (blog).
const render = (site, origin) => execFileSync('bash', ['-c', '. "$1"; render_user "$2" "$3"', 'x', libPath, site, origin],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '' } });
const rendered = render('blog', 'https://blog.skyphusionwp.dev');
const has = (re) => re.test(rendered);
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
ok('PHP_ENV value matches render_user', varOf('PHP_ENV').text === '{"USE_ZEND_ALLOC":"0"}' && has(/^PHP_ENV = '\{"USE_ZEND_ALLOC":"0"\}'$/m));
ok('PHP_IN_DO = on matches render_user', varOf('PHP_IN_DO').text === 'on' && has(/^PHP_IN_DO = "on"$/m));
ok('PHP_DO_POOL = 1 matches render_user', varOf('PHP_DO_POOL').text === '1' && has(/^PHP_DO_POOL = "1"$/m));
ok('DB_IN_DO = on matches render_user (b-dosql)', varOf('DB_IN_DO').text === 'on' && has(/^DB_IN_DO = "on"$/m));
ok('SITE_ORIGIN is emitted and present in render_user', varOf('SITE_ORIGIN') && has(/^SITE_ORIGIN = "https:\/\/blog\.skyphusionwp\.dev"$/m));
ok('PHP_LOCATION is emitted and present in render_user', varOf('PHP_LOCATION') && has(/^PHP_LOCATION = "[a-z]+"$/m));

// 3. The resource bindings match render_user.
ok('IMAGES binding matches render_user ([images] binding = "IMAGES")',
  byType('images').some((x) => x.name === 'IMAGES') && has(/^\[images\]\nbinding = "IMAGES"$/m));
ok('MEDIA r2_bucket is the site own bucket wp-wfp-<name>-media',
  byType('r2_bucket').some((x) => x.name === 'MEDIA' && x.bucket_name === 'wp-wfp-blog-media') && has(/^\[\[r2_buckets\]\]\nbinding = "MEDIA"\nbucket_name = "wp-wfp-blog-media"$/m));
ok('PHP_RUNTIME durable object = PhpRuntime matches render_user',
  byType('durable_object_namespace').some((x) => x.name === 'PHP_RUNTIME' && x.class_name === 'PhpRuntime') &&
  has(/^\[\[durable_objects\.bindings\]\]\nname = "PHP_RUNTIME"\nclass_name = "PhpRuntime"$/m));

// 4. EMAIL: the provisioning config emits an EMAIL send_email binding, and so does render_user
// (through mail-from.mjs, which is why a grep of lib.sh never saw it: #345 found the old "render_user
// omits send_email" assertion passing while render_user printed it). Both are checked on output.
ok('EMAIL send_email is emitted', byType('send_email').some((x) => x.name === 'EMAIL'));
ok('send_email is an allowed binding type (USER_OK) and deploy.sh emits it',
  USER_OK.has('send_email') && deploySh.includes('mail-from.mjs') && deploySh.includes('--binding'));
ok('render_user EMITS a send_email binding named EMAIL (rendered output, not source text)',
  has(/^send_email = \[\{ name = "EMAIL", allowed_sender_addresses = \["[^"]+"\] \}\]$/m));

// 5. The instrument can FAIL: a value we do NOT emit, and a name that is not a
// var, are both absent, so the exact-match checks above are discriminating.
ok('negative control: render_user does not carry PHP_IN_DO = "off"', !has(/^PHP_IN_DO = "off"$/m));
ok('negative control: a bogus var name is not in render_user', !has(/^NOT_A_REAL_VAR =/m));
// The instrument sees a missing line: the same regex against output with the line removed is false.
ok('negative control: the DB_IN_DO matcher fails on output that lacks the line',
  !/^DB_IN_DO = "on"$/m.test(rendered.replace(/^DB_IN_DO = "on"$/m, '')));

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

// ---- #201 Phase 1 wave 2: object-cache L2 KV + durable email queue (DEFAULT-ON) --
// These are default-on, so the default set now carries them. Their binding TYPES
// (kv_namespace, queue) MUST be in USER_OK: test 1 at the top of this file reads
// USER_OK from bindings.py and fails if any emitted type is not allowed, so that
// single check couples the USER_OK fix to this wave. Here we assert the var + the
// binding are present by default; provision-test proves the per-site injection.
// object-cache L2 (#218) is DEFAULT-ON and per-site: present in the default set.
ok('object-cache L2 is ON by default (OBJECT_CACHE_L2 = on)',
  varOf('OBJECT_CACHE_L2') && varOf('OBJECT_CACHE_L2').text === 'on');
ok('the OC_KV object-cache L2 namespace binding is in the default set (kv_namespace)',
  byType('kv_namespace').some((x) => x.name === 'OC_KV'));
// durable async email (#190) is OPT-IN (default:false): default-on would divert order
// mail to a queue whose consumer subscription is a Phase-2 post-deploy step. So it is
// ABSENT by default and appears only when the descriptor is enabled.
ok('ASYNC_EMAIL_QUEUE / EMAIL_QUEUE are ABSENT from the default set (queue is opt-in)',
  !b.some((x) => x.name === 'ASYNC_EMAIL_QUEUE' || x.name === 'EMAIL_QUEUE'));
const bQ = bDosqlBindings({ mediaBucket: mediaBucketName('blog'), siteOrigin: 'https://blog.skyphusionwp.dev', location: 'enam', enable: ['async-email-queue'] });
ok('async-email-queue opt-in adds ASYNC_EMAIL_QUEUE=on + the EMAIL_QUEUE queue binding',
  bQ.some((x) => x.type === 'plain_text' && x.name === 'ASYNC_EMAIL_QUEUE' && x.text === 'on') &&
  bQ.some((x) => x.type === 'queue' && x.name === 'EMAIL_QUEUE'));
// KNOWN GAP: render_user emits neither the L2 KV wiring nor the queue wiring; the provisioning
// path adds them and their binding types are sanctioned by USER_OK, which is what the drift guard
// enforces. Asserted on the rendered output, so it goes red the day render_user starts emitting them.
ok('KNOWN GAP recorded: render_user output omits the L2 KV + email-queue wiring',
  !has(/OBJECT_CACHE_L2/) && !has(/ASYNC_EMAIL_QUEUE/) && !has(/OC_KV/) && !has(/EMAIL_QUEUE/));

// Pageview analytics (#201 Phase 2) is OPT-IN (default:false, a privacy implication).
// ABSENT by default; enabling binds the ANALYTICS analytics_engine dataset + WP_ANALYTICS=on.
ok('WP_ANALYTICS / ANALYTICS are ABSENT from the default set (analytics is opt-in)',
  !b.some((x) => x.name === 'WP_ANALYTICS' || x.name === 'ANALYTICS'));
const bA = bDosqlBindings({ mediaBucket: mediaBucketName('blog'), siteOrigin: 'https://blog.skyphusionwp.dev', location: 'enam', enable: ['analytics-engine'], analyticsDataset: 'wp-wfp-blog-analytics' });
ok('analytics-engine opt-in adds WP_ANALYTICS=on + the ANALYTICS analytics_engine binding with the per-site dataset',
  bA.some((x) => x.type === 'plain_text' && x.name === 'WP_ANALYTICS' && x.text === 'on') &&
  bA.some((x) => x.type === 'analytics_engine' && x.name === 'ANALYTICS' && x.dataset === 'wp-wfp-blog-analytics'));

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
