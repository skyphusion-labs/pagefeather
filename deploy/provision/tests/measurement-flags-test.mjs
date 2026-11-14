// A measurement flag never reaches a real site (#394): HEADROOM_PROBE turns on GET /_headroom, which ENDS
// the PHP object's isolate by design (spikes/b2-wordpress/headroom.mjs). It is a measurement-build flag,
// set only on a throwaway through deploy/wfp's environment, never by the reference provisioning path
// (deploy/provision) or the one-click path (deploy/oneclick, its vendored copy). This reads what both
// generators produce for b-dosql and approach A, and fails if either sets it.
//   node deploy/provision/tests/measurement-flags-test.mjs
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MEASUREMENT_ONLY = ['HEADROOM_PROBE'];
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };
const here = dirname(fileURLToPath(import.meta.url));
const paths = {
  'reference (deploy/provision)': join(here, '../wp-site-config.mjs'),
  'one-click (deploy/oneclick/vendor)': join(here, '../../oneclick/vendor/provision/wp-site-config.mjs'),
};
for (const [label, path] of Object.entries(paths)) {
  const m = await import(path);
  const outputs = {
    'b-dosql vars': m.bDosqlVars({ siteOrigin: 'https://site.example' }),
    'approach A vars': m.aVars({ siteOrigin: 'https://site.example' }),
  };
  for (const [what, vars] of Object.entries(outputs)) {
    ok(`${label}: ${what} is a non-empty list`, Array.isArray(vars) && vars.length > 0);
    const names = new Set(vars.map((v) => v.name));
    for (const flag of MEASUREMENT_ONLY) ok(`${label}: ${what} never set ${flag}`, !names.has(flag));
  }
}
console.log(`${fail} failing check(s)`);
process.exit(fail ? 1 : 0);
