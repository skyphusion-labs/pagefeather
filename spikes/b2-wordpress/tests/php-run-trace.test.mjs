// node --test spikes/b2-wordpress/tests/php-run-trace.test.mjs (#1277, the lead's ruling for the main measurement)
// The main measurement asks whether a tagged guest waits behind a gateway isolate that is running PHP. php-lock's
// "released" line logs only contended or long runs, so the PHP intervals it gives are incomplete, and a guest stuck behind an
// unlogged run would count against the result. With PF_TRACE_PHP_RUNS=1 (a throwaway only), every PHP run logs one
// m: php-run line: iso, start, end. Unset: zero lines, and no work past reading the flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { phpRunTraceOn, phpRunLine } from '../php-run-trace.mjs';

test('phpRunTraceOn: only the exact value "1"', () => {
	assert.equal(phpRunTraceOn({ PF_TRACE_PHP_RUNS: '1' }), true);
	for (const v of [undefined, '', '0', 'on', 'true', ' 1', 1]) assert.equal(phpRunTraceOn({ PF_TRACE_PHP_RUNS: v }), false, String(v));
	assert.equal(phpRunTraceOn(null), false);
});
test('phpRunLine: iso, start, end, ms and the call id', () => {
	assert.deepEqual(phpRunLine('iso9', 1000, 1250, { call: 'c-1' }), { m: 'php-run', iso: 'iso9', start: 1000, end: 1250, ms: 250, call: 'c-1' });
	assert.deepEqual(phpRunLine('iso9', 1000, 1000, null), { m: 'php-run', iso: 'iso9', start: 1000, end: 1000, ms: 0, call: null });
});
test('index.js: withPhp logs one php-run line per run, ONLY when the flag is on, from the run start (after the grant) to its end', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const w = src.slice(src.indexOf('function withPhp('), src.indexOf('function withPhp(') + 1400);
	assert.match(w, /const runTrace = phpRunTraceOn\(ENV\);\n\t\t\tconst runStart = runTrace \? Date\.now\(\) : 0;/, 'the start is read inside the granted run, only when on');
	assert.match(w, /if \(runTrace\) console\.log\(JSON\.stringify\(phpRunLine\(ISOLATE_ID, runStart, Date\.now\(\), tag\)\)\);/, 'one line at the end, only when on');
	assert.ok(w.indexOf('phpRunLine(') > w.indexOf('retirer.runEnd()'), 'logged in the finally, after the run ends');
});
test('nothing in deploy/ renders PF_TRACE_PHP_RUNS: it is an operator --var on a throwaway only, so no live site gets it', () => {
	const { execSync } = require_child();
	const hits = execSync('git grep -n PF_TRACE_PHP_RUNS -- deploy || true', { cwd: new URL('../../..', import.meta.url).pathname }).toString();
	assert.equal(hits.trim(), '', 'deploy/ must not render or record it: ' + hits);
});
import { createRequire } from 'node:module';
function require_child() { return createRequire(import.meta.url)('node:child_process'); }
