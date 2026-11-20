// node --import ./spikes/b2-wordpress/tests/fixtures/lean/register.mjs --test spikes/b2-wordpress/tests/mysql-lean-bridge.test.mjs
// (#1101) The lean MySQL client imports cloudflare:sockets, which Node cannot resolve. This hook (tests only) maps it to a
// stub, and, for a bridge imported with ?fake, maps the bridge's ./mysql-lean.js to a fake LeanMysql the test drives.
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);
