// node --test spikes/b2-wordpress/tests/call-id-a.test.mjs (#1101 item 3)
// On approach A, none of the 5xx answers in strummer's checkout load arm carried x-pf-call, and their log lines carried no
// call id: PHP runs in the Worker, so the b-dosql forward that makes and passes a call id (#708) never happens. An error
// answer must carry the id that Workers Logs can be searched by. A's local run now has one (the overflow id when the
// request fell through from overflow, else a new one): the PHP lock tags its lines with it, tagCallId sets x-pf-call on the
// answer (every error answer is no-store, so it is tagged), and the error and req lines carry it. PHP runs are serialized
// per isolate, so the run's id is a module variable for the run's length (never a property on the native ctx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('#1101 A: the local run has a call id (the overflow one when it fell through), on the lock tag and on the answer', () => {
	assert.match(src, /const callId = ovCall \|\| crypto\.randomUUID\(\); \/\/ #1101/);
	assert.match(src, /const workerRun = await withPhp\(\(\) => withRunCall\(callId, \(\) => handle\(req, env, url, spikeOk, maxBody, ctx\), Date\.now\(\) - lockT0\), \{ shedMs: phpShedMs\(env, false\), priority: templateQueuePriority\(req\.method, url\), staleAction: 'shed', tag: \{ call: callId \} \}\);/);
	assert.match(src, /return tagCallId\(workerRun === PHP_SHED \? phpShedResponse\(\) : workerRun, callId\);/);
});
test('#1101: the error lines and the req line carry the call id (A: the run id; b-dosql: ctx.callId)', () => {
	for (const m of ["'@event': 'write-loss', m: 'write-loss', method: req.method", "'@event': 'statement-failure', m: 'statement-failure', class: 'platform'", "'@event': 'statement-failure', m: 'statement-failure', class: 'deterministic'"]) {
		const i = src.indexOf(m);
		assert.ok(i > 0, m);
		const line = src.slice(i, src.indexOf('\n', i));
		assert.match(line, /\.\.\.callTag\(ctx\)/, m);
	}
	assert.match(src, /console\.log\(JSON\.stringify\(\{ m: 'req', path: url\.pathname, boot: booted, d1: d\.calls, \.\.\.callTag\(ctx\) \}\)\);/);
	assert.match(src, /function callTag\(ctx\) \{\n\tconst call = \(ctx && ctx\.callId\) \|\| runCallId;\n\treturn call \? \{ call \} : \{\};\n\}/);
});
test('#1101: the object path request-killed lines carry the call id it already has', () => {
	assert.match(src, /console\.log\(JSON\.stringify\(\{ m: tag, kind, path: url\.pathname, retried, \.\.\.memIdOf\(req, env\), call: callId, error:/);
	assert.match(src, /'@event': 'write-loss', m: 'write-loss', kind, method: req\.method, path: url\.pathname, failed: 'unknown', phase: 'request-killed', \.\.\.memIdOf\(req, env\), call: callId,/);
});
