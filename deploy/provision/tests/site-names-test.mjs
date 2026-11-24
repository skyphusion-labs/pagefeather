#!/usr/bin/env node
// #328 PR 1: siteNames is the ONE table of derived resource names. It must match
// deploy/wfp/lib.sh helpers, terraform/site locals, and bindings.py ownership
// patterns. The reserved-name union with lib.sh valid_site must not loosen a rule.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReservedName, assertValidName } from '../shared.mjs';
import {
  siteNames,
  mediaBucketName,
  ocKvNamespaceName,
  emailQueueName,
  emailDlqName,
  analyticsDatasetName,
  searchIndexName,
} from '../wp-site-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
let fails = 0;
function ok(label, cond) {
  if (cond) console.log(`ok - ${label}`);
  else { console.log(`not ok - ${label}`); fails += 1; }
}

const n = siteNames('blog');
ok('siteNames.script', n.script === 'site-blog');
ok('siteNames.dispatcher', n.dispatcher === 'wp-blog');
ok('siteNames.mediaBucket', n.mediaBucket === 'wp-wfp-blog-media');
ok('siteNames.ocKv', n.ocKv === 'wp-wfp-blog-oc');
ok('siteNames.emailQueue', n.emailQueue === 'wp-wfp-blog-email');
ok('siteNames.emailDlq', n.emailDlq === 'wp-wfp-blog-email-dlq');
ok('siteNames.analyticsDataset', n.analyticsDataset === 'wp-wfp-blog-analytics');
ok('siteNames.searchIndex', n.searchIndex === 'wp-wfp-blog-search');
ok('siteNames.hyperdriveConfig', n.hyperdriveConfig === 'wp-wfp-blog');

ok('mediaBucketName delegates', mediaBucketName('blog') === n.mediaBucket);
ok('ocKvNamespaceName delegates', ocKvNamespaceName('blog') === n.ocKv);
ok('emailQueueName delegates', emailQueueName('blog') === n.emailQueue);
ok('emailDlqName delegates', emailDlqName('blog') === n.emailDlq);
ok('analyticsDatasetName delegates', analyticsDatasetName('blog') === n.analyticsDataset);
ok('searchIndexName delegates', searchIndexName('blog') === n.searchIndex);

try { siteNames(''); ok('siteNames empty throws', false); }
catch { ok('siteNames empty throws', true); }

// lib.sh helpers (user_script, dispatcher_name, media_bucket, search_index) and valid_site.
const sh = spawnSync('bash', ['-c', `
  . deploy/wfp/lib.sh >/dev/null
  echo "script=$(user_script blog)"
  echo "dispatcher=$(dispatcher_name blog)"
  echo "media=$(media_bucket blog)"
  echo "search=$(search_index blog)"
  for x in blog probe dispatch cacheprobe cacheprobe-direct auto wfp-x ggc; do
    if valid_site "$x"; then echo "valid_$x=1"; else echo "valid_$x=0"; fi
  done
`], { cwd: root, encoding: 'utf8' });
ok('lib.sh sourced for name helpers', sh.status === 0);
const lines = Object.fromEntries(
  (sh.stdout || '').trim().split('\n').filter(Boolean).map((l) => l.split('=')),
);
ok('lib.sh user_script matches siteNames.script', lines.script === n.script);
ok('lib.sh dispatcher_name matches siteNames.dispatcher', lines.dispatcher === n.dispatcher);
ok('lib.sh media_bucket matches siteNames.mediaBucket', lines.media === n.mediaBucket);
ok('lib.sh search_index matches siteNames.searchIndex', lines.search === n.searchIndex);

// terraform/site locals and OC_KV title (string patterns in main.tf).
const tf = readFileSync(join(root, 'deploy/wfp/terraform/site/main.tf'), 'utf8');
ok('terraform media_bucket local matches pattern', tf.includes('media_bucket = "wp-wfp-${var.name}-media"'));
ok('terraform OC_KV title matches pattern', tf.includes('title      = "wp-wfp-${var.name}-oc"'));

// bindings.py ownership patterns.
const py = readFileSync(join(root, 'deploy/wfp/bindings.py'), 'utf8');
ok('bindings.py media bucket pattern', py.includes('"wp-wfp-%s-media" % s'));
ok('bindings.py OC_KV title pattern', py.includes('"wp-wfp-%s-oc" % s') || py.includes('wp-wfp-%s-oc'));
ok('bindings.py queue pattern', py.includes('"wp-wfp-%s-email" % s'));
ok('bindings.py analytics pattern', py.includes('"wp-wfp-%s-analytics" % s'));
ok('bindings.py search pattern', py.includes('"wp-wfp-%s-search" % s'));
ok('bindings.py Hyperdrive config name pattern', py.includes('"wp-wfp-%s" % s') || py.includes('wp-wfp-%s"'));

// Reserved-name union with lib.sh: core must refuse every name lib.sh refuses.
// No rule loosened (a name lib.sh accepts must still pass SITE_NAME_RE here when not reserved).
for (const bad of ['probe', 'dispatch', 'cacheprobe', 'cacheprobe-direct', 'auto', 'wfp-x']) {
  ok(`lib.sh refuses ${bad}`, lines[`valid_${bad}`] === '0');
  ok(`core refuses ${bad}`, isReservedName(bad) === true);
  let threw = false;
  try { assertValidName(bad); } catch { threw = true; }
  ok(`assertValidName refuses ${bad}`, threw);
}
ok('lib.sh accepts blog', lines.valid_blog === '1');
ok('lib.sh accepts ggc', lines.valid_ggc === '1');
ok('core accepts blog', (() => { try { assertValidName('blog'); return true; } catch { return false; } })());
ok('core accepts ggc', (() => { try { assertValidName('ggc'); return true; } catch { return false; } })());

if (fails) { console.error(`${fails} failed`); process.exit(1); }
console.log('all passed');
