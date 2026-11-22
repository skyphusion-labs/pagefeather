// #1215: a non-blocking wp_remote_*() is fire-and-forget, as in core. The bridge answers PHP at once and runs the
// request in the request's waitUntil, under its own cap, never the caller's timeout (Action Scheduler sends 0.01 s; the
// far end must run to completion, as it does on stock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { httpBlocking, httpTimeoutMs, NONBLOCKING_CAP_MS } from '../http-nonblocking.mjs';

test('#1215 blocking is the default; only blocking false is non-blocking', () => {
	assert.equal(httpBlocking({}), true);
	assert.equal(httpBlocking({ blocking: true }), true);
	assert.equal(httpBlocking({ blocking: 0 }), true, 'only the boolean false the bridge sends');
	assert.equal(httpBlocking({ blocking: false }), false);
	assert.equal(httpBlocking(null), true);
});

test('#1215 the timeout: a blocking request keeps its own (1 s floor, 5 s default); a non-blocking one runs to the cap', () => {
	assert.equal(httpTimeoutMs({ timeout: 0.01 }), 1000);
	assert.equal(httpTimeoutMs({ timeout: 15 }), 15000);
	assert.equal(httpTimeoutMs({}), 5000);
	assert.equal(httpTimeoutMs({ blocking: false, timeout: 0.01 }), NONBLOCKING_CAP_MS);
	assert.equal(NONBLOCKING_CAP_MS, 30000, 'within the waitUntil window a Worker keeps after its response');
});

test('#1215 index.js: a non-blocking op is checked, then queued in waitUntil, and PHP gets queued at once', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{ httpBlocking, httpTimeoutMs \} from '\.\/http-nonblocking\.mjs';/);
	const at = src.indexOf('async function httpOp(op) {');
	assert.ok(at > 0);
	const body = src.slice(at, src.indexOf('\n}\n', at));
	assert.match(body, /if \(!httpBlocking\(op\)\) \{/, 'the non-blocking branch');
	assert.match(body, /httpFirstHopRefusal\(op\)/, 'a refusal is still answered as an error');
	assert.match(body, /ocCtx\.waitUntil\(/, 'the request runs on after PHP has its answer');
	assert.match(body, /return \{ queued: true \};/);
	// #1225 (the lead's ruling, option 1): queued ONLY outside an object; in one it is awaited as a blocking request.
	assert.match(body, /if \(ocCtx && ocCtx\.inObject\) return httpOpRun\(\{ \.\.\.op, blocking: true \}\);/);
	assert.ok(body.indexOf('ocCtx.inObject') < body.indexOf('ocCtx.waitUntil('), 'the object check comes before any queueing');
	assert.match(body, /httpOpRun\(\{ \.\.\.op, discard: true \}\)/, 'a queued request holds no body');
	assert.match(src, /if \(op\.discard\) continue;/);
	assert.match(src, /\.\.\.\(op\.discard \? \{ queued: true, iso: ISOLATE_ID \} : \{\}\)/, 'a queued request\'s http line says so, and where it ran');
	// #1226 kept: the hop's route is selfFetchRoute's, so only a refused SELF-fetch is logged as one.
	assert.match(src, /const self = httpHop\(url, ovs\);\n\t\t\tconst why = self\.why;/);
	assert.match(src, /return \{ route: self\.route, why(, missWhy: self\.missWhy)? \};/);
	assert.match(src, /const timeoutMs = httpTimeoutMs\(op\);/, 'one timeout rule');
});
