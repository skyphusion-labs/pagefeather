// Unit test for the b-dosql integration-descriptor table (#201 Phase 1). Proves
// the reducer assembles the SAME bytes the old hard-coded bDosqlBindings emitted
// for the default site (the refactor is behavior-preserving), that an opt-in
// descriptor (PDF invoices) adds exactly its binding + generated secret and
// NOTHING for a default site, and that the secret / resource-op seams the next
// wave uses are empty by default. No network, no deploy.
import { deepStrictEqual } from 'node:assert';
import {
  B_DOSQL_DESCRIPTORS, assembleBDosql, bDosqlBindings, bDosqlVars,
  bDosqlSecrets, bDosqlResourceCreateOps, mediaBucketName,
} from '../wp-site-config.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

const DEFAULT_OPTS = { mediaBucket: mediaBucketName('blog'), siteOrigin: 'https://blog.skyphusionwp.dev', location: 'enam' };

// 1. BYTE-EQUIVALENCE: the default set equals the exact array the OLD inline
// bDosqlBindings produced, element for element and key for key. This is the
// proof the descriptor-table refactor changed no bytes for the current site.
const EXPECTED_DEFAULT = [
  { type: 'plain_text', name: 'PHP_ENV', text: '{"USE_ZEND_ALLOC":"0"}' },
  { type: 'plain_text', name: 'SITE_ORIGIN', text: 'https://blog.skyphusionwp.dev' },
  { type: 'plain_text', name: 'PHP_IN_DO', text: 'on' },
  { type: 'plain_text', name: 'PHP_LOCATION', text: 'enam' },
  { type: 'plain_text', name: 'PHP_DO_POOL', text: '1' },
  { type: 'plain_text', name: 'DB_IN_DO', text: 'on' },
  { type: 'images', name: 'IMAGES' },
  { type: 'r2_bucket', name: 'MEDIA', bucket_name: 'wp-wfp-blog-media' },
  { type: 'durable_object_namespace', name: 'PHP_RUNTIME', class_name: 'PhpRuntime' },
  { type: 'send_email', name: 'EMAIL' },
];
let eq = true;
try { deepStrictEqual(bDosqlBindings(DEFAULT_OPTS), EXPECTED_DEFAULT); } catch { eq = false; }
ok('default bDosqlBindings is byte-identical to the old inline set (deepStrictEqual)', eq);
ok('default set JSON string matches the old set exactly',
  JSON.stringify(bDosqlBindings(DEFAULT_OPTS)) === JSON.stringify(EXPECTED_DEFAULT));

// 2. The table carries the five always-on descriptors plus PDF, in emit order.
ok('descriptor order is runtime, images, media, php-runtime, email, pdf-invoices',
  B_DOSQL_DESCRIPTORS.map((d) => d.name).join(',') === 'runtime,images,media,php-runtime,email,pdf-invoices');
ok('the five infra descriptors are default-on and PDF is opt-in',
  B_DOSQL_DESCRIPTORS.filter((d) => d.default).map((d) => d.name).join(',') === 'runtime,images,media,php-runtime,email' &&
  B_DOSQL_DESCRIPTORS.find((d) => d.name === 'pdf-invoices').default === false);

// 3. Reducer parts for a default site: no secrets, no resource ops, vars first.
const asm = assembleBDosql(DEFAULT_OPTS);
ok('default assemble has no generated secrets', Object.keys(asm.secretGenerators).length === 0);
ok('default assemble has no resource-create ops', asm.resourceCreateOps.length === 0);
ok('vars come before bindings in the assembled order',
  asm.vars.every((v) => v.type === 'plain_text') &&
  asm.bindings[0].name === 'IMAGES' && asm.bindings[asm.bindings.length - 1].name === 'EMAIL');

// 4. bDosqlVars is the runtime var subset, in order.
ok('bDosqlVars emits exactly the six runtime vars in order',
  bDosqlVars(DEFAULT_OPTS).map((v) => v.name).join(',') === 'PHP_ENV,SITE_ORIGIN,PHP_IN_DO,PHP_LOCATION,PHP_DO_POOL,DB_IN_DO');

// 5. PDF opt-in: exactly one BROWSER binding appended after EMAIL, INVOICE_TOKEN
// generated, and the DEFAULT set is untouched (no browser, no secret).
const pdf = bDosqlBindings({ ...DEFAULT_OPTS, enable: ['pdf-invoices'] });
ok('PDF opt-in appends exactly one BROWSER binding after EMAIL',
  pdf.length === EXPECTED_DEFAULT.length + 1 &&
  JSON.stringify(pdf[pdf.length - 1]) === JSON.stringify({ type: 'browser', name: 'BROWSER' }) &&
  pdf[pdf.length - 2].name === 'EMAIL');
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

// 7. The resource-op seam is empty for default + PDF (BROWSER needs no resource).
ok('bDosqlResourceCreateOps is empty for the default set', bDosqlResourceCreateOps(DEFAULT_OPTS).length === 0);
ok('bDosqlResourceCreateOps is empty for a PDF site (BROWSER needs no provisioned resource)',
  bDosqlResourceCreateOps({ ...DEFAULT_OPTS, enable: ['pdf-invoices'] }).length === 0);

// 8. The required-input guards still fire through the reducer.
let threw = false; try { bDosqlBindings({ siteOrigin: 'https://x' }); } catch { threw = true; }
ok('bDosqlBindings still requires mediaBucket', threw);
threw = false; try { bDosqlVars({}); } catch { threw = true; }
ok('bDosqlVars still requires siteOrigin', threw);

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
