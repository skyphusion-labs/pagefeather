// Offline test of the CLI arg parsing (#154 stage 2). Pure, no IO.
import assert from 'node:assert';
import { parseArgs, genSecret } from '../cli.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

ok('add --kind wp <name>', (() => { const a = parseArgs(['add', '--kind', 'wp', 'blog']); return a.cmd === 'add' && a.kind === 'wp' && a.name === 'blog'; })());
ok('add --kind shop is REJECTED (c1 store path retired #214)', throws(() => parseArgs(['add', 'store', '--kind', 'shop'])));
ok('add rejects a bad kind', throws(() => parseArgs(['add', '--kind', 'db', 'x'])));
ok('add rejects a bad name', throws(() => parseArgs(['add', '--kind', 'wp', 'Bad_Name'])));
ok('add rejects a demo-lane name (caller cannot pick the demo lane)', throws(() => parseArgs(['add', '--kind', 'wp', 'demo-abc123def45678'])));
ok('add rejects a missing name', throws(() => parseArgs(['add', '--kind', 'wp'])));
ok('unknown command rejected', throws(() => parseArgs(['frobnicate'])));
ok('list and remove are recognized commands', parseArgs(['list']).cmd === 'list' && parseArgs(['remove', 'x']).cmd === 'remove');
ok('genSecret is hex of the requested length', /^[0-9a-f]{64}$/.test(genSecret(32)) && /^[0-9a-f]{48}$/.test(genSecret(24)));
ok('two genSecret calls differ', genSecret() !== genSecret());

ok('add --kind a <name> --hyperdrive <id> parses (approach A)', (() => { const a = parseArgs(['add', '--kind', 'a', 'astore', '--hyperdrive', 'abc123']); return a.kind === 'a' && a.name === 'astore' && a.hyperdrive === 'abc123'; })());
ok('add --kind a REQUIRES --hyperdrive (the onboarding config id)', throws(() => parseArgs(['add', '--kind', 'a', 'astore'])));
ok('add --kind a accepts and parses --hyperdrive-sql-mode', (() => { const a = parseArgs(['add', '--kind', 'a', 'astore', '--hyperdrive', 'id', '--hyperdrive-sql-mode', 'ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION']); return a.hyperdriveSqlMode === 'ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'; })());
ok('add --kind a rejects a bad --hyperdrive-sql-mode (charset guard against injection)', throws(() => parseArgs(['add', '--kind', 'a', 'astore', '--hyperdrive', 'id', '--hyperdrive-sql-mode', 'DROP TABLE x; --'])));
ok('add rejects an unknown flag (a typo must fail loudly, not drop the value)', throws(() => parseArgs(['add', '--kind', 'wp', 'blog', '--bogus', 'x'])));
console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
