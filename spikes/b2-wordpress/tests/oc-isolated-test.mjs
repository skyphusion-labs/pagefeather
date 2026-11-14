// node spikes/b2-wordpress/tests/oc-isolated-test.mjs [index.js]
//
// Source invariants for the approach-A object-cache port and its instrumentation
// (issue #218). index.js cannot be imported without a build, so this checks the
// shipped source the way build-evict-test.mjs does. A live run is the lead's Paid
// measurement step.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2] || resolve(here, '..', 'index.js');
const src = readFileSync(path, 'utf8');
let fails = 0;
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) fails++; };

// The object cache is defined for approach A (dbHandler set), off by default, and
// only when it is NOT a b-dosql deploy.
ok('approach-A object cache is gated on dbHandler + OBJECT_CACHE=on, not DB_IN_DO',
	src.includes("dbHandler && ENV.DB_IN_DO !== 'on' && ENV.OBJECT_CACHE === 'on'"));
ok("approach A defines JS_OBJECT_CACHE", src.includes("define('JS_OBJECT_CACHE', true);"));
ok('approach A sets the persist-group allowlist', src.includes("define('JS_OBJECT_CACHE_PERSIST_GROUPS', "));
ok('approach A sets the bounded TTL', src.includes("define('JS_OBJECT_CACHE_TTL', "));
// The allowlist default must NOT contain a WooCommerce or posts group (correctness rule).
const def = (src.match(/: '([a-z0-9_,-]+)';\s*\n\s*lines\.push\("define\('JS_OBJECT_CACHE_PERSIST_GROUPS'/) || [])[1] || '';
ok('the default allowlist excludes WooCommerce groups', def.length > 0 && !/woo|wc_|product|session|cart|order/.test(def));
ok('the default allowlist excludes posts/post_meta', def.length > 0 && !/\bpost/.test(def));
ok('#491: the default allowlist excludes options (a stale alloptions across isolates is a lost update)', def.length > 0 && !/(^|,)options(,|$)/.test(def));

// The per-request off bracket is spike-gated, like x-ast-cache-off.
ok('x-oc-off is stripped without a spike token', src.includes("if (!spikeOk) delete headers['x-oc-off'];"));

// Instrumentation: per-table DB counts, per-group cache stats, the x-oc-stats header.
ok('per-table DB counting on the approach-A path', src.includes('if (m.mysql !== undefined) countTable(String(m.mysql));'));
ok('countTable + dbTableOf exist', src.includes('function countTable(sql)') && src.includes('function dbTableOf(sql)'));
ok('per-group object-cache counting exists', src.includes('function ocCount(k, field)') && src.includes('ocCount(k, "hit")') && src.includes('ocCount(k, "miss")'));
ok('diffCounts survives nested requests via a start snapshot', src.includes('function diffCounts(now, was)') && src.includes('dbTables: { ...stats.dbTables }'));
ok('the x-oc-stats header is emitted', src.includes("out.set('x-oc-stats'") && src.includes('tables: ocTables') && src.includes('groups: ocGroupStats'));

console.log(`${fails} failing check(s)`);
process.exit(fails ? 1 : 0);
