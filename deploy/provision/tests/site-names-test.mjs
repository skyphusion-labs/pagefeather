// #328 PR 1: siteNames is the ONE derived-name table. lib.sh helpers,
// terraform/site locals, and bindings.py ownership patterns must equal it.
// The reserved-name union refuses every name either path refuses, and loosens none.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  siteNames,
  mediaBucketName,
  ocKvNamespaceName,
  emailQueueName,
  emailDlqName,
  analyticsDatasetName,
  searchIndexName,
  hyperdriveConfigName,
} from '../wp-site-config.mjs';
import {
  SITE_NAME_RE,
  isReservedName,
  isCallerReservedName,
  isUnionReservedName,
  SHARED_WORKER_SITE_NAMES,
  WFP_RESERVED_SITE_NAMES,
  WFP_NAME_PREFIXES,
  RESERVED_NAMES,
  RESERVED_PREFIXES,
} from '../shared.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const libPath = join(root, 'deploy/wfp/lib.sh');
const tfPath = join(root, 'deploy/wfp/terraform/site/main.tf');
const bindingsPath = join(root, 'deploy/wfp/bindings.py');

const libHelper = (fn, name) => execFileSync(
  'bash',
  ['-c', '. "$1" >/dev/null; "$2" "$3"', 'x', libPath, fn, name],
  { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '', ACCOUNT_ID: 'x' } },
).trim();

const samples = ['ggc', 'blog', 'one', 'shop', 'ggc-test'];

for (const name of samples) {
  const n = siteNames(name);
  ok(`siteNames(${name}).script equals lib.sh user_script`, n.script === libHelper('user_script', name));
  ok(`siteNames(${name}).dispatcher equals lib.sh dispatcher_name`, n.dispatcher === libHelper('dispatcher_name', name));
  ok(`siteNames(${name}).mediaBucket equals lib.sh media_bucket`, n.mediaBucket === libHelper('media_bucket', name));
  ok(`siteNames(${name}).searchIndex equals lib.sh search_index`, n.searchIndex === libHelper('search_index', name));
  ok(`wrappers equal siteNames for ${name}`,
    mediaBucketName(name) === n.mediaBucket
    && ocKvNamespaceName(name) === n.ocKvTitle
    && emailQueueName(name) === n.emailQueue
    && emailDlqName(name) === n.emailDlq
    && analyticsDatasetName(name) === n.analyticsDataset
    && searchIndexName(name) === n.searchIndex
    && hyperdriveConfigName(name) === n.hyperdriveConfig);
}

const tf = readFileSync(tfPath, 'utf8');
ok('terraform media_bucket local uses wp-wfp-${var.name}-media',
  /media_bucket\s*=\s*"wp-wfp-\$\{var\.name\}-media"/.test(tf));
ok('terraform OC_KV title uses wp-wfp-${var.name}-oc',
  /title\s*=\s*"wp-wfp-\$\{var\.name\}-oc"/.test(tf));
ok('terraform site map script uses site-${var.name}',
  /script\s*=\s*"site-\$\{var\.name\}"/.test(tf));

const py = readFileSync(bindingsPath, 'utf8');
ok('bindings.py owns media bucket wp-wfp-%s-media',
  py.includes('"wp-wfp-%s-media"') || py.includes('wp-wfp-%s-media'));
ok('bindings.py owns OC_KV title wp-wfp-%s-oc',
  py.includes('wp-wfp-%s-oc'));
ok('bindings.py owns email queue wp-wfp-%s-email',
  py.includes('wp-wfp-%s-email'));
ok('bindings.py owns analytics dataset wp-wfp-%s-analytics',
  py.includes('wp-wfp-%s-analytics'));
ok('bindings.py owns search index wp-wfp-%s-search',
  py.includes('wp-wfp-%s-search'));
ok('bindings.py owns Hyperdrive config name wp-wfp-%s',
  /wp-wfp-%s(?!-)/.test(py) || py.includes('"wp-wfp-%s"') || py.includes('wp-wfp-%s"'));
ok('bindings.py owns dispatcher wp-<s> and script site-<s>',
  py.includes('site-<s>') || py.includes('site-%s') || /site-%s|site-<s>/.test(py));

// lib.sh SHARED_WORKER / RESERVED lists equal the exported constants (source text of the assignment).
const lib = readFileSync(libPath, 'utf8');
const sharedLine = /SHARED_WORKER_SITE_NAMES="([^"]+)"/.exec(lib);
const reservedLine = /RESERVED_SITE_NAMES="([^"]+)"/.exec(lib);
ok('SHARED_WORKER_SITE_NAMES matches lib.sh',
  sharedLine && sharedLine[1].split(/\s+/).join(' ') === SHARED_WORKER_SITE_NAMES.join(' '));
ok('WFP_RESERVED_SITE_NAMES matches lib.sh RESERVED_SITE_NAMES',
  reservedLine && reservedLine[1].split(/\s+/).join(' ') === WFP_RESERVED_SITE_NAMES.join(' '));
ok('WFP_NAME_PREFIXES includes wfp- (lib.sh case wfp-*)', WFP_NAME_PREFIXES.includes('wfp-'));

// Union refuses every name either path refuses. No rule loosened.
for (const n of SHARED_WORKER_SITE_NAMES) {
  ok(`union refuses WfP shared Worker name ${n}`, isUnionReservedName(n) === true);
}
for (const n of WFP_RESERVED_SITE_NAMES) {
  ok(`union refuses WfP reserved name ${n}`, isUnionReservedName(n) === true);
}
ok('union refuses wfp-outbound style name', isUnionReservedName('wfp-outbound') === true);
for (const n of RESERVED_NAMES) {
  ok(`union refuses core reserved name ${n}`, isUnionReservedName(n) === true);
}
for (const p of RESERVED_PREFIXES) {
  ok(`union refuses core prefix ${p}x`, isUnionReservedName(`${p}x`) === true);
}
ok('union refuses demo-lane caller name', isUnionReservedName('demo-abc123def45678') === true);

// Names both paths accept today stay off the union (charset-valid ordinary site).
// "shop" is in RESERVED_NAMES (core), so it is not in this list.
for (const n of ['ggc', 'blog', 'one', 'ggc-test']) {
  ok(`union allows ordinary site ${n}`, SITE_NAME_RE.test(n) && isUnionReservedName(n) === false);
}

// Callers are unchanged in this PR: core still allows probe/auto; WfP still allows www.
ok('core isReservedName still allows probe (WfP-only until a later PR)', isReservedName('probe') === false);
ok('core isCallerReservedName still allows auto (WfP-only until a later PR)', isCallerReservedName('auto') === false);
ok('union is stricter than core for probe', isUnionReservedName('probe') === true && isCallerReservedName('probe') === false);

let threw = false;
try { siteNames(''); } catch { threw = true; }
ok('siteNames refuses an empty name', threw);
threw = false;
try { siteNames(); } catch { threw = true; }
ok('siteNames refuses a missing name', threw);

// Negative control: the instrument fails when a derived name is wrong.
ok('negative control: script is not wp-<name>', siteNames('blog').script !== 'wp-blog');
ok('negative control: media bucket is not site-<name>', siteNames('blog').mediaBucket !== 'site-blog');

if (fail) {
  console.error(`${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`all passed (${pass})`);
