// Offline test of the CLI arg parsing (#154 stage 2). Pure, no IO.
import assert from 'node:assert';
import { parseArgs, genSecret } from '../cli.mjs';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('PASS', n); } else { fail++; console.log('FAIL', n); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

ok('add --kind wp <name>', (() => { const a = parseArgs(['add', '--kind', 'wp', 'blog']); return a.cmd === 'add' && a.kind === 'wp' && a.name === 'blog'; })());
ok('add --kind shop <name> (name before or after --kind)', (() => { const a = parseArgs(['add', 'store', '--kind', 'shop']); return a.kind === 'shop' && a.name === 'store'; })());
ok('add rejects a bad kind', throws(() => parseArgs(['add', '--kind', 'db', 'x'])));
ok('add rejects a bad name', throws(() => parseArgs(['add', '--kind', 'wp', 'Bad_Name'])));
ok('add rejects a demo-lane name (caller cannot pick the demo lane)', throws(() => parseArgs(['add', '--kind', 'wp', 'demo-abc123def45678'])));
ok('add rejects a missing name', throws(() => parseArgs(['add', '--kind', 'wp'])));
ok('unknown command rejected', throws(() => parseArgs(['frobnicate'])));
ok('list and remove are recognized commands', parseArgs(['list']).cmd === 'list' && parseArgs(['remove', 'x']).cmd === 'remove');
ok('genSecret is hex of the requested length', /^[0-9a-f]{64}$/.test(genSecret(32)) && /^[0-9a-f]{48}$/.test(genSecret(24)));
ok('two genSecret calls differ', genSecret() !== genSecret());

console.log(fail === 0 ? `all passed (${pass})` : `${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
