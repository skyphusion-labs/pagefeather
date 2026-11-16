// #715 review3 6: the one-click emitters (wp-site-config.mjs bDosqlVars and aVars, through objectTimeInputs) render
// OBJECT_CALL_DEADLINE_S and OBJECT_START_BY_S with the same rule as deploy/object-time.sh, so a one-click site has
// the #708 escape hatch as IaC. Unset adds no var. A bad value throws before any bundle or API call.
//   node deploy/provision/tests/object-time-test.mjs
const m = await import('../wp-site-config.mjs');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };
const val = (bs, n) => { const b = (bs || []).find((x) => x && x.name === n); return b ? b.text : null; };
const inputs = typeof m.objectTimeInputs === 'function' ? m.objectTimeInputs : () => { throw new Error('objectTimeInputs is not exported'); };
const both = (env) => {
  const i = inputs(env);
  return { b: m.bDosqlVars({ siteOrigin: 'https://s.example', ...i }), a: m.aVars({ siteOrigin: 'https://s.example', ...i }) };
};
const tryBoth = (env) => { try { return both(env); } catch (e) { return { error: e.message }; } };
let r = tryBoth({});
ok('unset adds neither var (b-dosql and a)', !r.error && val(r.b, 'OBJECT_START_BY_S') === null && val(r.a, 'OBJECT_CALL_DEADLINE_S') === null);
r = tryBoth({ OBJECT_START_BY_S: 'off' });
ok('OBJECT_START_BY_S=off renders on both', !r.error && val(r.b, 'OBJECT_START_BY_S') === 'off' && val(r.a, 'OBJECT_START_BY_S') === 'off');
r = tryBoth({ OBJECT_START_BY_S: '90', OBJECT_CALL_DEADLINE_S: '120' });
ok('90 under a 120 s deadline renders both', !r.error && val(r.b, 'OBJECT_START_BY_S') === '90' && val(r.b, 'OBJECT_CALL_DEADLINE_S') === '120');
for (const [env, why] of [[{ OBJECT_START_BY_S: '61' }, 'over the cap at the default'], [{ OBJECT_START_BY_S: '0' }, 'zero'], [{ OBJECT_CALL_DEADLINE_S: '601' }, 'deadline over 600'], [{ OBJECT_START_BY_S: 'on' }, 'not a number']]) {
  r = tryBoth(env);
  ok('refused: ' + why, Boolean(r.error));
}
let threw = false; try { inputs({ OBJECT_START_BY_S: '61' }); } catch { threw = true; }
ok('objectTimeInputs itself refuses, so the callers refuse before IO', threw);
const fs = await import('node:fs');
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
ok('cli.mjs spreads objectTimeInputs for b-dosql and a', (src('../cli.mjs').match(/\.\.\.objectTimeInputs\(env\)/g) || []).length === 2);
ok('server-config.mjs spreads it for b-dosql and a', (src('../server-config.mjs').match(/\.\.\.objectTimeInputs\(env\)/g) || []).length === 2);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
