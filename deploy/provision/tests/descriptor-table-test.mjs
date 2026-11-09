// Unit test for the b-dosql integration-descriptor table (#201 Phase 1). Proves
// the reducer assembles the intended default set (the five always-on infra
// descriptors PLUS the default-on per-site object-cache L2 KV, #218), that the
// opt-in descriptors add exactly their own pieces and NOTHING for a default site
// (PDF invoices, the zone-purge PURGE_ZONE var + SUPPLIED PURGE_TOKEN, and the
// durable async-email queue #190), and that the secret / resource-op seams carry
// exactly what the enabled descriptors contribute. No network, no deploy.
import { deepStrictEqual } from 'node:assert';
import {
  B_DOSQL_DESCRIPTORS, assembleBDosql, bDosqlBindings, bDosqlVars,
  bDosqlSecrets, bDosqlResourceCreateOps, mediaBucketName,
} from '../wp-site-config.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

const DEFAULT_OPTS = { mediaBucket: mediaBucketName('blog'), siteOrigin: 'https://blog.skyphusionwp.dev', location: 'enam' };

// 1. BYTE-EQUIVALENCE: the default set equals the exact array the reducer must
// produce for a current b-dosql site, element for element and key for key. The
// baseline was RE-FROZEN for the default-on object-cache L2 (#218): the default
// site now gains the OBJECT_CACHE_L2 var + the OC_KV binding. OC_KV carries no
// namespace_id here; the per-site id is injected by its resourceCreateOp at
// provision (see provision-test), exactly as approach A's OC_KV injection does.
// The async-email queue is OPT-IN (default:false), so it is NOT in this baseline.
const EXPECTED_DEFAULT = [
  { type: 'plain_text', name: 'PHP_ENV', text: '{"USE_ZEND_ALLOC":"0"}' },
  { type: 'plain_text', name: 'SITE_ORIGIN', text: 'https://blog.skyphusionwp.dev' },
  { type: 'plain_text', name: 'PHP_IN_DO', text: 'on' },
  { type: 'plain_text', name: 'PHP_LOCATION', text: 'enam' },
  { type: 'plain_text', name: 'PHP_DO_POOL', text: '1' },
  { type: 'plain_text', name: 'DB_IN_DO', text: 'on' },
  { type: 'plain_text', name: 'OBJECT_CACHE_L2', text: 'on' },
  { type: 'images', name: 'IMAGES' },
  { type: 'r2_bucket', name: 'MEDIA', bucket_name: 'wp-wfp-blog-media' },
  { type: 'durable_object_namespace', name: 'PHP_RUNTIME', class_name: 'PhpRuntime' },
  { type: 'send_email', name: 'EMAIL' },
  { type: 'kv_namespace', name: 'OC_KV' },
];
let eq = true;
try { deepStrictEqual(bDosqlBindings(DEFAULT_OPTS), EXPECTED_DEFAULT); } catch { eq = false; }
ok('default bDosqlBindings matches the frozen baseline (deepStrictEqual)', eq);
ok('default set JSON string matches the frozen baseline exactly',
  JSON.stringify(bDosqlBindings(DEFAULT_OPTS)) === JSON.stringify(EXPECTED_DEFAULT));

// 2. The table carries the six default-on descriptors plus the three opt-ins, in order.
ok('descriptor order is runtime, images, media, php-runtime, email, pdf-invoices, zone-purge, object-cache-l2, async-email-queue',
  B_DOSQL_DESCRIPTORS.map((d) => d.name).join(',') === 'runtime,images,media,php-runtime,email,pdf-invoices,zone-purge,object-cache-l2,async-email-queue');
ok('the six infra descriptors are default-on; PDF, zone-purge and async-email-queue are opt-in',
  B_DOSQL_DESCRIPTORS.filter((d) => d.default).map((d) => d.name).join(',') === 'runtime,images,media,php-runtime,email,object-cache-l2' &&
  B_DOSQL_DESCRIPTORS.find((d) => d.name === 'pdf-invoices').default === false &&
  B_DOSQL_DESCRIPTORS.find((d) => d.name === 'zone-purge').default === false &&
  B_DOSQL_DESCRIPTORS.find((d) => d.name === 'async-email-queue').default === false);

// 3. Reducer parts for a default site: no generated secrets, exactly the one
// default-on resource op (object-cache-l2 KV create), vars before bindings.
const asm = assembleBDosql(DEFAULT_OPTS);
ok('default assemble has no generated secrets', Object.keys(asm.secretGenerators).length === 0);
ok('default assemble has exactly the object-cache-l2 resource-create op',
  asm.resourceCreateOps.map((r) => r.name).join(',') === 'object-cache-l2' && typeof asm.resourceCreateOps[0].op === 'function');
ok('vars come before bindings in the assembled order',
  asm.vars.every((v) => v.type === 'plain_text') &&
  asm.bindings[0].name === 'IMAGES' && asm.bindings[asm.bindings.length - 1].name === 'OC_KV');

// 4. bDosqlVars is the RUNTIME var subset only (not the integration vars), in order.
ok('bDosqlVars emits exactly the six runtime vars in order',
  bDosqlVars(DEFAULT_OPTS).map((v) => v.name).join(',') === 'PHP_ENV,SITE_ORIGIN,PHP_IN_DO,PHP_LOCATION,PHP_DO_POOL,DB_IN_DO');

// 5. PDF opt-in: exactly one BROWSER binding appended after the default set,
// INVOICE_TOKEN generated, and the DEFAULT set is untouched (no browser, no secret).
const pdf = bDosqlBindings({ ...DEFAULT_OPTS, enable: ['pdf-invoices'] });
ok('PDF opt-in adds exactly one BROWSER binding (object-cache-l2 OC_KV follows it in array order)',
  pdf.length === EXPECTED_DEFAULT.length + 1 &&
  pdf.filter((b) => b.type === 'browser').length === 1 &&
  JSON.stringify(pdf.find((b) => b.type === 'browser')) === JSON.stringify({ type: 'browser', name: 'BROWSER' }) &&
  pdf[pdf.length - 1].name === 'OC_KV');
ok('default set carries NO browser binding', !bDosqlBindings(DEFAULT_OPTS).some((b) => b.type === 'browser'));
ok('PDF opt-in generates an INVOICE_TOKEN secret',
  typeof bDosqlSecrets({ ...DEFAULT_OPTS, enable: ['pdf-invoices'] }).INVOICE_TOKEN === 'string' &&
  bDosqlSecrets({ ...DEFAULT_OPTS, enable: ['pdf-invoices'] }).INVOICE_TOKEN.length >= 24);
ok('two PDF provisions generate DIFFERENT INVOICE_TOKEN values (a per-site secret)',
  bDosqlSecrets({ ...DEFAULT_OPTS, enable: ['pdf-invoices'] }).INVOICE_TOKEN !==
  bDosqlSecrets({ ...DEFAULT_OPTS, enable: ['pdf-invoices'] }).INVOICE_TOKEN);
ok('default secrets are empty (WP_SALT/SPIKE_TOKEN are the CLI literal, not the table)',
  Object.keys(bDosqlSecrets(DEFAULT_OPTS)).length === 0);

// 6. Negative control: an unknown opt-in name changes nothing, so the enable
// path is discriminating (the byte-equal above is not a match-everything check).
ok('an unknown opt-in name is ignored (default set unchanged)',
  JSON.stringify(bDosqlBindings({ ...DEFAULT_OPTS, enable: ['not-a-descriptor'] })) === JSON.stringify(EXPECTED_DEFAULT));

// 7. The resource-op seam: default carries the object-cache-l2 op; PDF adds none
// of its own (BROWSER needs no provisioned resource), so a PDF site still has just it.
ok('bDosqlResourceCreateOps is exactly [object-cache-l2] for the default set',
  bDosqlResourceCreateOps(DEFAULT_OPTS).map((r) => r.name).join(',') === 'object-cache-l2');
ok('a PDF site adds no resource op (BROWSER needs none); still exactly [object-cache-l2]',
  bDosqlResourceCreateOps({ ...DEFAULT_OPTS, enable: ['pdf-invoices'] }).map((r) => r.name).join(',') === 'object-cache-l2');

// 7b. Object-cache L2 (#218) is DEFAULT-ON and PER-SITE: the OBJECT_CACHE_L2 var
// and the OC_KV kv_namespace binding are in the default set (no id until injected).
ok('object-cache L2 is ON by default (OBJECT_CACHE_L2 var = on)',
  bDosqlBindings(DEFAULT_OPTS).some((b) => b.type === 'plain_text' && b.name === 'OBJECT_CACHE_L2' && b.text === 'on'));
ok('the OC_KV kv_namespace binding is in the default set with no id until injected',
  bDosqlBindings(DEFAULT_OPTS).some((b) => b.type === 'kv_namespace' && b.name === 'OC_KV' && !('namespace_id' in b)));

// 7c. Durable async email (#190) is OPT-IN (default:false), NOT default-on: a
// default-on queue would divert order mail to a queue with no consumer (the
// consumer subscription is a Phase-2 post-deploy step). The default set carries
// NEITHER the ASYNC_EMAIL_QUEUE var NOR the EMAIL_QUEUE binding; both appear only
// when enabled, and enabling adds the per-site queue resource op.
ok('default set carries NO ASYNC_EMAIL_QUEUE var and NO EMAIL_QUEUE binding (queue is opt-in)',
  !bDosqlBindings(DEFAULT_OPTS).some((b) => b.name === 'ASYNC_EMAIL_QUEUE' || b.name === 'EMAIL_QUEUE'));
const aeq = bDosqlBindings({ ...DEFAULT_OPTS, enable: ['async-email-queue'] });
ok('async-email-queue opt-in adds the ASYNC_EMAIL_QUEUE var = on',
  aeq.some((b) => b.type === 'plain_text' && b.name === 'ASYNC_EMAIL_QUEUE' && b.text === 'on'));
ok('async-email-queue opt-in adds the EMAIL_QUEUE queue binding with no queue_name until injected',
  aeq.some((b) => b.type === 'queue' && b.name === 'EMAIL_QUEUE' && !('queue_name' in b)));
ok('async-email-queue opt-in adds its per-site queue resource op (object-cache-l2 + async-email-queue)',
  bDosqlResourceCreateOps({ ...DEFAULT_OPTS, enable: ['async-email-queue'] }).map((r) => r.name).join(',') === 'object-cache-l2,async-email-queue');

// 9. ZONE PURGE (#205/#256): default-OFF (zoneless site carries none), and when
// enabled WITH a zone it adds PURGE_ZONE (var) + PURGE_TOKEN (a SUPPLIED secret, not
// a generated one). Mirrors the runtime gate cachePurgeEnabled (both present).
const ZONE_OPTS = { ...DEFAULT_OPTS, enable: ['zone-purge'], purgeZone: 'ZONEID123', purgeToken: 'shared-platform-purge-token' };

// (a) zoneless DEFAULT site: no PURGE_ZONE var, no PURGE_TOKEN secret.
ok('default (zoneless) set carries NO PURGE_ZONE var',
  !bDosqlBindings(DEFAULT_OPTS).some((b) => b.name === 'PURGE_ZONE'));
ok('default (zoneless) secrets carry NO PURGE_TOKEN',
  bDosqlSecrets(DEFAULT_OPTS).PURGE_TOKEN === undefined);
ok('a PDF-only site (no zone) still carries NO PURGE_ZONE / PURGE_TOKEN',
  !bDosqlBindings({ ...DEFAULT_OPTS, enable: ['pdf-invoices'] }).some((b) => b.name === 'PURGE_ZONE') &&
  bDosqlSecrets({ ...DEFAULT_OPTS, enable: ['pdf-invoices'] }).PURGE_TOKEN === undefined);

// (b) WITH a zone configured: PURGE_ZONE var equals the zone id, PURGE_TOKEN secret
// equals the SUPPLIED token (not random). zone-purge adds no resource op of its own,
// so the only op present is the default object-cache-l2 one.
const zbind = bDosqlBindings(ZONE_OPTS);
const pz = zbind.find((b) => b.name === 'PURGE_ZONE');
ok('zone-purge adds a PURGE_ZONE plain_text var equal to the configured zone id',
  !!pz && pz.type === 'plain_text' && pz.text === 'ZONEID123');
ok('zone-purge adds PURGE_TOKEN as the SUPPLIED value (not generated)',
  bDosqlSecrets(ZONE_OPTS).PURGE_TOKEN === 'shared-platform-purge-token');
ok('PURGE_TOKEN is SUPPLIED, not per-site random: two provisions give the SAME value',
  bDosqlSecrets(ZONE_OPTS).PURGE_TOKEN === bDosqlSecrets(ZONE_OPTS).PURGE_TOKEN);
ok('zone-purge adds NO non-var binding and no resource op of its own (only object-cache-l2 remains)',
  bDosqlResourceCreateOps(ZONE_OPTS).map((r) => r.name).join(',') === 'object-cache-l2' &&
  zbind.filter((b) => b.type !== 'plain_text').length === EXPECTED_DEFAULT.filter((b) => b.type !== 'plain_text').length);

// (c) enabling zone-purge WITHOUT a zone or token fails loudly (the guard), so a
// misconfigured enable never wires PURGE_ZONE=undefined.
let zthrew = false; try { bDosqlBindings({ ...DEFAULT_OPTS, enable: ['zone-purge'] }); } catch { zthrew = true; }
ok('zone-purge enabled without a purgeZone throws', zthrew);
zthrew = false; try { bDosqlSecrets({ ...DEFAULT_OPTS, enable: ['zone-purge'], purgeZone: 'Z' }); } catch { zthrew = true; }
ok('zone-purge enabled without a purgeToken throws', zthrew);

// 8. The required-input guards still fire through the reducer.
let threw = false; try { bDosqlBindings({ siteOrigin: 'https://x' }); } catch { threw = true; }
ok('bDosqlBindings still requires mediaBucket', threw);
threw = false; try { bDosqlVars({}); } catch { threw = true; }
ok('bDosqlVars still requires siteOrigin', threw);

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
