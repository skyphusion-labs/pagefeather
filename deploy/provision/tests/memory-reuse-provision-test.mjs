// #724 review, finding 7, on the one-click path: PHP_MEMORY_REUSE and BOOT_GATE can reach a site only as caller-supplied
// extra bindings (cli.mjs WP_BINDINGS). Approach A refuses them (as deploy.sh does), and b-dosql applies the one rule
// (deploy/lib/memory-reuse.sh): each "on" or absent, the gate alone refused, the boot race test seam refused.
//   node deploy/provision/tests/memory-reuse-provision-test.mjs
const m = await import('../wp-site-config.mjs');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };
const pt = (name, text) => ({ type: 'plain_text', name, text });
const A = (extra) => { try { m.aBindings({ mediaBucket: 'b', hyperdriveId: 'h', siteOrigin: 'https://s.example', extra }); return null; } catch (e) { return e.message; } };
const B = (extra) => { try { m.bDosqlBindings({ mediaBucket: 'b', siteOrigin: 'https://s.example', extra }); return null; } catch (e) { return e.message; } };
ok('approach A with no reuse binding provisions', A([]) === null);
for (const name of ['PHP_MEMORY_REUSE', 'BOOT_GATE', 'BOOT_TEST_DELAY_MS', 'BOOT_TEST_DELAY_AT']) {
  const e = A([pt(name, 'on')]);
  ok(`approach A refuses ${name}`, typeof e === 'string' && /not supported on approach A/.test(e));
}
ok('b-dosql with no reuse binding provisions', B([]) === null);
ok('b-dosql: PHP_MEMORY_REUSE alone provisions', B([pt('PHP_MEMORY_REUSE', 'on')]) === null);
ok('b-dosql: the pair provisions', B([pt('PHP_MEMORY_REUSE', 'on'), pt('BOOT_GATE', 'on')]) === null);
ok('b-dosql: the gate alone is refused, with the reason', /BOOT_GATE=on needs PHP_MEMORY_REUSE=on/.test(B([pt('BOOT_GATE', 'on')]) || ''));
ok('b-dosql: a bad value is refused', /must be on/.test(B([pt('PHP_MEMORY_REUSE', 'yes')]) || ''));
ok('b-dosql: the test seam is refused', /local test seam/.test(B([pt('PHP_MEMORY_REUSE', 'on'), pt('BOOT_TEST_DELAY_MS', '1500')]) || ''));
console.log(`${fail} failing check(s)`);
process.exit(fail ? 1 : 0);
