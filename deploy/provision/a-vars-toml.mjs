// deploy.sh's approach-A settings, as Wrangler TOML, from the ONE source the provisioning path uses
// (#666): aVars and aBindings in wp-site-config.mjs, which a-site-config-test.mjs holds to the measured
// [env.a-paid-lean]. deploy.sh used to render none of them, so every #296 run used a hand-made config.
//
//   SITE_ORIGIN=https://x node a-vars-toml.mjs vars     the object cache and lazy-node [vars] lines
//   node a-vars-toml.mjs kv <namespace id>              the OC_KV [[kv_namespaces]] block
//
// `vars` leaves out the lines deploy.sh already writes for every variant (PHP_ENV, SITE_ORIGIN, the mail
// lines, HYPERDRIVE_SQL_MODE); any OTHER var aVars adds is printed, so a new setting reaches deploy.sh too.
import { aVars, aBindings } from './wp-site-config.mjs';

const OWN = new Set(['PHP_ENV', 'SITE_ORIGIN', 'MAIL_FROM', 'MAIL_FROM_NAME', 'HYPERDRIVE_SQL_MODE']);
const line = (k, v) => `${k} = ${JSON.stringify(String(v))}`;
const [cmd, arg] = process.argv.slice(2);
if (cmd === 'vars') {
	const vars = aVars({ siteOrigin: process.env.SITE_ORIGIN });
	for (const v of vars) if (!OWN.has(v.name)) console.log(line(v.name, v.text));
} else if (cmd === 'kv') {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(arg || '')) { console.error('a-vars-toml: kv needs the namespace id (Terraform output oc_kv_id)'); process.exit(2); }
	const kv = aBindings({ mediaBucket: 'x', hyperdriveId: 'x', siteOrigin: 'https://x', ocKvNamespaceId: arg }).find((b) => b.type === 'kv_namespace');
	console.log('[[kv_namespaces]]'); console.log(line('binding', kv.name)); console.log(line('id', kv.namespace_id));
} else {
	console.error('usage: a-vars-toml.mjs vars | kv <namespace id>'); process.exit(2);
}
