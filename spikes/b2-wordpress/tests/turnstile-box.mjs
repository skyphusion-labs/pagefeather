// node tests/turnstile-box.mjs
// Box test for the Turnstile siteverify path (issue #250). Calls the REAL Cloudflare
// siteverify endpoint through verifyToken (the same seam the Worker turnstileOp uses),
// with the documented test SECRET keys. No Cloudflare account or widget is needed:
// the test secrets are public and the pass/fail outcome is fixed by the secret.
//   - 1x0000000000000000000000000000000AA always passes.
//   - 2x0000000000000000000000000000000AA always fails.
// Proves: a good token passes, a bad token is rejected, a missing token is rejected
// without a network call. The PHP form gating (login block, comment reject, checkout
// fail, off switches) is proven by tests/turnstile-forms-test.php.
import { verifyToken } from '../turnstile.mjs';

const PASS_SECRET = '1x0000000000000000000000000000000AA';
const FAIL_SECRET = '2x0000000000000000000000000000000AA';
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

let fail = 0;
function check(label, got, want) {
	if (got === want) { console.log(`ok   ${label}`); return; }
	fail++; console.log(`FAIL ${label}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`);
}

const pass = await verifyToken(PASS_SECRET, DUMMY_TOKEN);
console.log('  pass-secret reply:', JSON.stringify(pass));
check('live: good token passes (success:true)', pass.success, true);

const bad = await verifyToken(FAIL_SECRET, DUMMY_TOKEN);
console.log('  fail-secret reply:', JSON.stringify(bad));
check('live: bad token rejected (success:false)', bad.success, false);
check('live: bad token is a real fail, not an outage', bad.error, undefined);

const missing = await verifyToken(PASS_SECRET, '');
check('missing token rejected', missing.success, false);
check('missing token short-circuits (no network)', missing.codes[0], 'missing-input-response');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
