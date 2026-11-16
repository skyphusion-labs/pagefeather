// node deploy/wfp/tests/vendor-sync-test.mjs (#739): the one-click site manager runs a byte-identical copy of
// deploy/wfp/dispatcher/ code (deploy/oneclick/vendor, sync-vendor.sh). An edit here without deploy/oneclick/sync-vendor.sh
// fails this suite, naming the file and the fix. The guard itself is proven in deploy/provision/tests/vendor-sync-test.mjs.
import { vendorCheck } from '../../oneclick/tests/vendor-check.mjs';
const r = vendorCheck('deploy/wfp/dispatcher/');
const good = r.code === 0 && /pairs? equal/.test(r.out);
console.log((good ? 'PASS' : 'FAIL') + ' every vendored copy of deploy/wfp/dispatcher/ equals its source (rc ' + r.code + ')');
if (!good) console.log(r.out);
console.log(good ? 'all passed (1)' : '1 failed');
process.exit(good ? 0 : 1);
