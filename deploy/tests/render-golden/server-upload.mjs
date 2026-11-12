// The provisioning Worker path for one golden case (#328 PR 0): buildServerCfg into provisionSite,
// with the stand-in API of capture.mjs. Prints the recorded calls as JSON.
//   node server-upload.mjs <site> <env JSON>
import { buildServerCfg } from '../../provision/server-config.mjs';
import { provisionSite } from '../../provision/provision.mjs';
import { makeRecorder, stable } from './capture.mjs';

const [site, envJson] = process.argv.slice(2);
const bundle = { key: 'bundles/b-dosql/current/index.js', text: 'export default {};\n' };
const env = {
  CF_ACCOUNT_ID: 'account-test', WP_PROVISION_TOKEN: 'token-test-not-real',
  WFP_KV_ID: 'kv-sites-test-id', WFP_NAMESPACE: 'wp-wfp',
  WFP_BASES: JSON.stringify({ 'sites.example': { saasZoneId: 'zone-test-id', workersSubdomain: 'sub' } }),
  BUNDLES: {
    list: async () => ({ objects: [{ key: bundle.key }] }),
    get: async (k) => (k === bundle.key ? { text: async () => bundle.text, arrayBuffer: async () => new TextEncoder().encode(bundle.text).buffer } : null),
  },
  ...JSON.parse(envJson || '{}'),
};
const rec = makeRecorder();
const dispatcher = { get: () => ({ fetch: async () => rec.fetchImpl('https://internal/_install', { method: 'POST' }) }) };
const cfg = await buildServerCfg(env, { kind: 'wp', name: site, domain: 'sites.example' });
await provisionSite({ acct: env.CF_ACCOUNT_ID, token: env.WP_PROVISION_TOKEN, fetchImpl: rec.fetchImpl, dispatcher }, cfg);
process.stdout.write(stable(rec.calls));
