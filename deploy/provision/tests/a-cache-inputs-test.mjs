// #296 defaults: the one-click approach-A path has an escape hatch for both new defaults (the lead's rule: a new
// default needs one on every path, as #715's OBJECT_START_BY_S=off). aCacheInputs(env) reads OBJECT_CACHE_VERSIONS
// (1 or 0) and WOO_HPOS_CACHE (on or off), the same values as deploy/a-settings.sh. Unset is ON. An explicit 0 or off
// wins. Anything else throws, before a bundle is read or an API call is made.
//   node deploy/provision/tests/a-cache-inputs-test.mjs
import { readFileSync } from 'node:fs';
const m = await import('../wp-site-config.mjs');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };
const inputs = typeof m.aCacheInputs === 'function' ? m.aCacheInputs : () => { throw new Error('aCacheInputs is not exported'); };
const render = (env) => m.aBindings({ mediaBucket: 'b', hyperdriveId: 'HDID', siteOrigin: 'https://s.example', ...inputs(env) });
const has = (bs, n) => bs.some((b) => b && b.type === 'plain_text' && b.name === n && b.text === 'on');
const tryRender = (env) => { try { return render(env); } catch (e) { return { error: e.message }; } };

let r = tryRender({});
ok('unset: both on (the #296 defaults)', !r.error && has(r, 'OBJECT_CACHE_VERSIONS') && has(r, 'WOO_HPOS_CACHE'));
r = tryRender({ OBJECT_CACHE_VERSIONS: '0', WOO_HPOS_CACHE: 'off' });
ok('a one-click A render with both off renders neither line', !r.error && !r.some((b) => b.name === 'OBJECT_CACHE_VERSIONS' || b.name === 'WOO_HPOS_CACHE'));
r = tryRender({ OBJECT_CACHE_VERSIONS: '0' });
ok('OBJECT_CACHE_VERSIONS=0 alone: versions off, HPOS cache still on', !r.error && !r.some((b) => b.name === 'OBJECT_CACHE_VERSIONS') && has(r, 'WOO_HPOS_CACHE'));
r = tryRender({ WOO_HPOS_CACHE: 'off' });
ok('WOO_HPOS_CACHE=off alone: HPOS cache off, versions still on', !r.error && has(r, 'OBJECT_CACHE_VERSIONS') && !r.some((b) => b.name === 'WOO_HPOS_CACHE'));
r = tryRender({ OBJECT_CACHE_VERSIONS: '1', WOO_HPOS_CACHE: 'on' });
ok('explicit on renders both', !r.error && has(r, 'OBJECT_CACHE_VERSIONS') && has(r, 'WOO_HPOS_CACHE'));
for (const env of [{ OBJECT_CACHE_VERSIONS: 'off' }, { OBJECT_CACHE_VERSIONS: 'yes' }, { WOO_HPOS_CACHE: '0' }, { WOO_HPOS_CACHE: 'OFF' }]) {
  ok('refused: ' + JSON.stringify(env), Boolean(tryRender(env).error));
}
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
for (const f of ['../cli.mjs', '../server-config.mjs']) {
  const s = src(f);
  ok(f + ' forwards aCacheInputs into the approach-A bindings', /aBindings\(\{[\s\S]{0,900}\.\.\.aCacheInputs\(env\)/.test(s));
  ok(f + ' checks it before any IO, with objectTimeInputs', /objectTimeInputs\(env\);?[^\n]*aCacheInputs\(env\)|aCacheInputs\(env\);?[^\n]*objectTimeInputs\(env\)/.test(s) || /aCacheInputs\(env\); \/\/ #296/.test(s));
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
