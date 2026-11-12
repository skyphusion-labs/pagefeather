// Render every golden case into <out dir> (#328 PR 0). For each case in cases.json:
//   render_user.toml      deploy/wfp/lib.sh render_user <site> <origin>
//   cli-upload.json       deploy/provision/cli.mjs add --kind wp <site>, every API call recorded
//   cli-bindings.json     deploy/wfp/bindings.py on the bindings the CLI uploaded
//   server-upload.json    server-config.mjs buildServerCfg into provision.mjs, every API call recorded
//   server-bindings.json  deploy/wfp/bindings.py on the bindings the Worker path uploaded
// Each emitter runs with ONLY the case env (and PATH), so the env of the shell that runs the
// test cannot change a golden. No network call is made.
//   node deploy/tests/render-golden/render.mjs <out dir>
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const out = process.argv[2];
if (!out) { console.error('usage: render.mjs <out dir>'); process.exit(2); }
const { cases } = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8'));

function run(label, cmd, args, env) {
  const r = spawnSync(cmd, args, { cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`${label}: exit ${r.status}\n${r.stderr}`);
    process.exit(1);
  }
  return r.stdout;
}

for (const c of cases) {
  const dir = join(out, c.id);
  mkdirSync(dir, { recursive: true });
  const host = new URL(c.origin).host;
  writeFileSync(join(dir, 'render_user.toml'),
    run(`${c.id} render_user`, 'bash', ['-c', '. deploy/wfp/lib.sh && render_user "$0" "$1"', c.site, c.origin], c.env));
  const cliCap = join(dir, 'cli-upload.json');
  run(`${c.id} cli`, 'node', ['--import', join(HERE, 'cli-preload.mjs'), 'deploy/provision/cli.mjs', 'add', '--kind', 'wp', c.site], {
    CLOUDFLARE_ACCOUNT_ID: 'account-test', CLOUDFLARE_API_TOKEN: 'token-test-not-real',
    WFP_KV_ID: 'kv-sites-test-id', WFP_SAAS_ZONE_ID: 'zone-test-id', WFP_SUBDOMAIN: 'sub',
    WP_HOSTNAME: host, SITE_ORIGIN: c.origin, BDOSQL_BUNDLE_DIR: join(HERE, 'bundle'),
    GOLDEN_CAPTURE: cliCap, ...c.env,
  });
  writeFileSync(join(dir, 'cli-bindings.json'), run(`${c.id} cli bindings`, 'python3', ['-I', join(HERE, 'bindings-decision.py'), c.site, cliCap], {}));
  const srvCap = join(dir, 'server-upload.json');
  writeFileSync(srvCap, run(`${c.id} server`, 'node', [join(HERE, 'server-upload.mjs'), c.site, JSON.stringify(c.env)], {}));
  writeFileSync(join(dir, 'server-bindings.json'), run(`${c.id} server bindings`, 'python3', ['-I', join(HERE, 'bindings-decision.py'), c.site, srvCap], {}));
}
console.log(`rendered ${cases.length} cases into ${out}`);
