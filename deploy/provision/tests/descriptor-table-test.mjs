// Unit test for the b-dosql integration-descriptor table (#201 Phase 1). Proves
// the reducer assembles the intended default set (the five always-on infra
// descriptors PLUS the two default-on wave-2 integrations, object-cache L2 KV and
// durable async email), that an opt-in descriptor (PDF invoices) adds exactly its
// binding + generated secret and NOTHING extra, and that the secret / resource-op
// seams carry exactly what the enabled descriptors contribute. No network, no deploy.
import { deepStrictEqual } from 'node:assert';
import {
  B_DOSQL_DESCRIPTORS, assembleBDosql, bDosqlBindings, bDosqlVars,
  bDosqlSecrets, bDosqlResourceCreateOps, mediaBucketName,
} from '../wp-site-config.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

const DEFAULT_OPTS = { mediaBucket: mediaBucketName('blog'), siteOrigin: 'https://blog.skyphusionwp.dev', location: 'enam' };

// 1. BYTE-EQUIVALENCE: the default set equals the exact array the reducer must
// produce for a current b-dosql site, element for element and key for key. This is
// the frozen baseline. It was RE-FROZEN for the wave-2 defaults (#218 object-cache
// L2 KV, #190 durable async email): the default-site output now gains the
// OBJECT_CACHE_L2 + ASYNC_EMAIL_QUEUE vars and the OC_KV + EMAIL_QUEUE bindings.
// OC_KV carries no namespace_id and EMAIL_QUEUE no queue_name here: the
// per-site id / queue_name is injected by each descriptor's resourceCreateOp at
// provision time (see provision-test), exactly as approach A's OC_KV injection does.
const EXPECTED_DEFAULT = [
  { type: 'plain_text', name: 'PHP_ENV', text: '{"USE_ZEND_ALLOC":"0"}' },
  { type: 'plain_text', name: 'SITE_ORIGIN', text: 'https://blog.skyphusionwp.dev' },
  { type: 'plain_text', name: 'PHP_IN_DO', text: 'on' },
  { type: 'plain_text', name: 'PHP_LOCATION', text: 'enam' },
  { type: 'plain_text', name: 'PHP_DO_POOL', text: '1' },
  { type: 'plain_text', name: 'DB_IN_DO', text: 'on' },
  { type: 'plain_text', name: 'OBJECT_CACHE_L2', text: 'on' },
  { type: 'plain_text', name: 'ASYNC_EMAIL_QUEUE', text: 'on' },
  { type: 'images', name: 'IMAGES' },
  { type: 'r2_bucket', name: 'MEDIA', bucket_name: 'wp-wfp-blog-media' },
  { type: 'durable_object_namespace', name: 'PHP_RUNTIME', class_name: 'PhpRuntime' },
  { type: 'send_email', name: 'EMAIL' },
  { type: 'kv_namespace', name: 'OC_KV' },
  { type: 'queue', name: 'EMAIL_QUEUE' },
];
let eq = true;
try { deepStrictEqual(bDosqlBindings(DEFAULT_OPTS), EXPECTED_DEFAULT); } catch { eq = false; }
ok('default bDosqlBindings matches the frozen wave-2 baseline (deepStrictEqual)', eq);
ok('default set JSON string matches the frozen baseline exactly',
  JSON.stringify(bDosqlBindings(DEFAULT_OPTS)) === JSON.stringify(EXPECTED_DEFAULT));

// The two wave-2 defaults are PRESENT by default (an explicit guard, not only the
// byte-equal above): the var is on and the binding is in the set.
ok('object-cache L2 is ON by default (OBJECT_CACHE_L2 var = on)',
  bDosqlBindings(DEFAULT_OPTS).some((b) => b.type === 'plain_text' && b.name === 'OBJECT_CACHE_L2' && b.text === 'on'));
ok('the OC_KV kv_namespace binding is in the default set (no id until injected)',
  bDosqlBindings(DEFAULT_OPTS).some((b) => b.type === 'kv_namespace' && b.name === 'OC_KV' && !('namespace_id' in b)));
ok('durable async email is ON by default (ASYNC_EMAIL_QUEUE var = on)',
  bDosqlBindings(DEFAULT_OPTS).some((b) => b.type === 'plain_text' && b.name === 'ASYNC_EMAIL_QUEUE' && b.text === 'on'));
ok('the EMAIL_QUEUE queue binding is in the default set (no queue_name until injected)',
  bDosqlBindings(DEFAULT_OPTS).some((b) => b.type === 'queue' && b.name === 'EMAIL_QUEUE' && !('queue_name' in b)));

// 2. The table carries the seven default-on descriptors plus PDF, in emit order.
ok('descriptor order is runtime, images, media, php-runtime, email, object-cache-l2, async-email-queue, pdf-invoices',
  B_DOSQL_DESCRIPTORS.map((d) => d.name).join(',') === 'runtime,images,media,php-runtime,email,object-cache-l2,async-email-queue,pdf-invoices');
ok('the seven infra/integration descriptors are default-on and PDF is opt-in',
  B_DOSQL_DESCRIPTORS.filter((d) => d.default).map((d) => d.name).join(',') === 'runtime,images,media,php-runtime,email,object-cache-l2,async-email-queue' &&
  B_DOSQL_DESCRIPTORS.find((d) => d.name === 'pdf-invoices').default === false);

// 3. Reducer parts for a default site: no generated secrets, TWO resource ops
// (the L2 KV and the email queue), vars before bindings.
const asm = assembleBDosql(DEFAULT_OPTS);
ok('default assemble has no generated secrets', Object.keys(asm.secretGenerators).length === 0);
ok('default assemble has exactly the two default-on resource-create ops',
  asm.resourceCreateOps.map((r) => r.name).join(',') === 'object-cache-l2,async-email-queue');
ok('every resource-create op carries an async op function', asm.resourceCreateOps.every((r) => typeof r.op === 'function'));
ok('vars come before bindings in the assembled order',
  asm.vars.every((v) => v.type === 'plain_text') &&
  asm.bindings[0].name === 'IMAGES' && asm.bindings[asm.bindings.length - 1].name === 'EMAIL_QUEUE');

// 4. bDosqlVars is the RUNTIME var subset only (not the integration vars), in order.
ok('bDosqlVars emits exactly the six runtime vars in order',
  bDosqlVars(DEFAULT_OPTS).map((v) => v.name).join(',') === 'PHP_ENV,SITE_ORIGIN,PHP_IN_DO,PHP_LOCATION,PHP_DO_POOL,DB_IN_DO');

// 5. PDF opt-in: exactly one BROWSER binding appended after the default set,
// INVOICE_TOKEN generated, and the DEFAULT set is untouched (no browser, no secret).
const pdf = bDosqlBindings({ ...DEFAULT_OPTS, enable: ['pdf-invoices'] });
ok('PDF opt-in appends exactly one BROWSER binding after the default set',
  pdf.length === EXPECTED_DEFAULT.length + 1 &&
  JSON.stringify(pdf[pdf.length - 1]) === JSON.stringify({ type: 'browser', name: 'BROWSER' }) &&
  pdf[pdf.length - 2].name === 'EMAIL_QUEUE');
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

// 7. The resource-op seam carries the two default-on ops, and PDF adds none of its
// own (BROWSER needs no provisioned resource), so a PDF site still has exactly two.
ok('bDosqlResourceCreateOps has the two default-on ops for the default set',
  bDosqlResourceCreateOps(DEFAULT_OPTS).map((r) => r.name).join(',') === 'object-cache-l2,async-email-queue');
ok('a PDF site adds NO resource op (BROWSER needs none); still exactly the two defaults',
  bDosqlResourceCreateOps({ ...DEFAULT_OPTS, enable: ['pdf-invoices'] }).map((r) => r.name).join(',') === 'object-cache-l2,async-email-queue');

// 8. The required-input guards still fire through the reducer.
let threw = false; try { bDosqlBindings({ siteOrigin: 'https://x' }); } catch { threw = true; }
ok('bDosqlBindings still requires mediaBucket', threw);
threw = false; try { bDosqlVars({}); } catch { threw = true; }
ok('bDosqlVars still requires siteOrigin', threw);

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
