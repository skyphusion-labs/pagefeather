// #328 PR 2: wranglerToml equals render_user for the golden matrix, and the
// thin render_user path delegates to the Node emitter.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wranglerToml, WranglerTomlError } from '../wrangler-toml.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const { cases } = JSON.parse(readFileSync(join(root, 'deploy/tests/render-golden/cases.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME || '', ACCOUNT_ID: 'x' };

for (const c of cases) {
  const env = { ...baseEnv, ...c.env };
  const fromNode = wranglerToml({ site: c.site, origin: c.origin, env });
  const golden = readFileSync(join(root, 'deploy/tests/render-golden/goldens', c.id, 'render_user.toml'), 'utf8');
  ok(`wranglerToml equals golden ${c.id}`, fromNode === golden);

  const ru = spawnSync('bash', ['-c', '. deploy/wfp/lib.sh >/dev/null; render_user "$0" "$1"', c.site, c.origin], {
    cwd: root, encoding: 'utf8', env,
  });
  ok(`thin render_user equals golden ${c.id}`, ru.status === 0 && ru.stdout === golden);
}

// DB_QUERY_TIMEOUT_MS is refused in the thin render_user wrapper before Node runs.
const timeout = spawnSync('bash', ['-c', '. deploy/wfp/lib.sh >/dev/null; render_user "$0" "$1"', 'one', 'https://wp-one.sub.workers.dev'], {
  cwd: root, encoding: 'utf8', env: { ...baseEnv, DB_QUERY_TIMEOUT_MS: '1000' },
});
ok('thin render_user refuses DB_QUERY_TIMEOUT_MS', timeout.status !== 0 && /DB_QUERY_TIMEOUT/.test(timeout.stderr));

let threw = false;
try {
  wranglerToml({ site: 'one', origin: 'https://x', env: { ...baseEnv, OBSERVABILITY: 'nope' } });
} catch (e) {
  threw = e instanceof WranglerTomlError && /OBSERVABILITY/.test(e.stderr || e.message);
}
ok('wranglerToml refuses a bad OBSERVABILITY', threw);

if (fail) {
  console.error(`${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`all passed (${pass})`);
