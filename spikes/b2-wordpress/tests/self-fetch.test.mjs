import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selfFetchRoute, selfFetchPoolAvailable, SELF_REFUSAL_GUARD, SELF_REFUSAL_OBJECT, SELF_REFUSAL_NO_POOL, SELF_REFUSAL_CAPPED } from '../self-fetch.mjs';

// #1157: url-details for the site's own URL answered 404 no_response on cf759hw, where stock passes.
const base = { sameHost: true, inObject: false, overflowed: false, poolAvailable: true, capped: false };
test('#1157 another host takes the normal path', () => {
	assert.equal(selfFetchRoute({ ...base, sameHost: false }).route, 'out');
	assert.equal(selfFetchRoute({ ...base, sameHost: false, inObject: true, poolAvailable: false }).route, 'out');
});
test('#1157 the site own host on the approach A Worker with the pool goes to a pool object', () => {
	assert.deepEqual(selfFetchRoute(base), { route: 'pool' });
});
test('#1157 recursion guard: a request a pool object runs never calls the pool again', () => {
	assert.deepEqual(selfFetchRoute({ ...base, inObject: true, overflowed: true }), { route: 'refuse', why: SELF_REFUSAL_GUARD });
});
test('#1157 in any other object (cron object, DO tier site object) a self-request is still refused', () => {
	assert.deepEqual(selfFetchRoute({ ...base, inObject: true }), { route: 'refuse', why: SELF_REFUSAL_OBJECT });
});
test('#1157 no pool, or the held cap reached: refused, never global fetch()', () => {
	assert.deepEqual(selfFetchRoute({ ...base, poolAvailable: false }), { route: 'refuse', why: SELF_REFUSAL_NO_POOL });
	assert.deepEqual(selfFetchRoute({ ...base, capped: true }), { route: 'refuse', why: SELF_REFUSAL_CAPPED });
});
test('#1157 the pool is available on the same condition as the overflow dispatch', () => {
	const env = { PHP_RUNTIME: {} };
	assert.equal(selfFetchPoolAvailable(env, { on: true }), true);
	assert.equal(selfFetchPoolAvailable(env, { on: false }), false);
	assert.equal(selfFetchPoolAvailable({}, { on: true }), false);
	assert.equal(selfFetchPoolAvailable({ ...env, PHP_IN_DO: 'on' }, { on: true }), false);
	assert.equal(selfFetchPoolAvailable({ ...env, DB_IN_DO: 'on' }, { on: true }), false);
});
test('#1157 index.js: every bridge hop asks selfFetchRoute, sends pool hops through toPhpObject, and logs self-fetch', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /const self = selfFetchRoute\(\{ sameHost: isSelfHost\(url\), inObject: Boolean\(ocCtx && ocCtx\.inObject\), overflowed: Boolean\(ocCtx && ocCtx\.overflowed\), poolAvailable: selfFetchPoolAvailable\(ENV, ovs\), capped: overHeld\(ovs, ovHeld\) \}\);/);
	assert.match(src, /res = self\.route === 'pool' \? await selfFetchOnPool\(url, method, headers, body, signal\) : await fetch\(url, \{ method, headers, body, redirect: 'manual', signal \}\);/);
	assert.match(src, /toPhpObject\(new Request\(url, \{ method, headers, body, signal, redirect: 'manual' \}\), ENV, url, null, \{ name: SELF_FETCH_OBJECT, hint: ovs\.hint, overflow: true, callId \}\)/);
	assert.match(src, /m: 'self-fetch'/);
	assert.doesNotMatch(src, /function httpRefusal\(url\) \{\n[^\n]*\n\tif \(bootOrigin && url\.hostname === new URL\(bootOrigin\)\.hostname\)/, 'the old blanket refusal is gone');
});
test('#1157 same-isolate guard: an object finds an in-flight hop of its own isolate and answers at once', async () => {
	const { selfFetchCalls, selfFetchSameIsolate } = await import('../self-fetch.mjs');
	selfFetchCalls.add('c1');
	assert.equal(selfFetchSameIsolate(true, 'c1'), true);
	assert.equal(selfFetchSameIsolate(false, 'c1'), false, 'only an overflowed request');
	assert.equal(selfFetchSameIsolate(true, 'c2'), false, 'another isolate (the live pool) never has the id');
	assert.equal(selfFetchSameIsolate(true, null), false);
	selfFetchCalls.delete('c1');
	assert.equal(selfFetchSameIsolate(true, 'c1'), false);
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /if \(selfFetchSameIsolate\(overflowed, raw\.headers\.get\(CALL_HEADER\)\)\) \{\n\t+return new Response\(null, \{ status: 503, headers: \{ \[SELF_SAME_ISOLATE_HEADER\]: '1'/);
	assert.match(src, /selfFetchCalls\.add\(callId\);/);
	assert.match(src, /\} finally \{\n\t\tselfFetchCalls\.delete\(callId\);/);
});

// #1170 live (strummer, cf759hx at b234810): the routing worked, but each try picked a different COLD pool object (a boot
// plus two PHP runs for the 301), 5.8 to 8.6 s, past WordPress's 5 s timeout; and a timed-out hop left no self-fetch line.
test('#1170 self-fetches go to ONE named pool object, kept warm by its own use, outside the client picker', async () => {
	const { SELF_FETCH_OBJECT } = await import('../self-fetch.mjs');
	assert.equal(SELF_FETCH_OBJECT, 'ovf-self');
	const { overflowName } = await import('../overflow.mjs');
	for (let i = 0; i < 128; i++) assert.notEqual(overflowName(i), SELF_FETCH_OBJECT, 'never one the client overflow picks');
});
test('#1170 every self-fetch outcome is named for its log line', async () => {
	const { selfFetchOutcome } = await import('../self-fetch.mjs');
	assert.equal(selfFetchOutcome({ status: 200, aborted: false, error: null, sameIsolate: false }), 'ok');
	assert.equal(selfFetchOutcome({ status: 301, aborted: false, error: null, sameIsolate: false }), 'ok', 'a redirect is an answer; the bridge loop checks the next hop');
	assert.equal(selfFetchOutcome({ status: null, aborted: true, error: new Error('x'), sameIsolate: false }), 'timeout');
	assert.equal(selfFetchOutcome({ status: 200, aborted: true, error: null, sameIsolate: false }), 'timeout', 'aborted wins');
	assert.equal(selfFetchOutcome({ status: null, aborted: false, error: new Error('x'), sameIsolate: false }), 'error');
	assert.equal(selfFetchOutcome({ status: 503, aborted: false, error: null, sameIsolate: true }), 'same-isolate');
});
test('#1170 index.js: the self-fetch line is logged on EVERY path (before any throw), with the outcome', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const f = src.slice(src.indexOf('async function selfFetchOnPool('), src.indexOf('function httpRefusal(url)'));
	const log = f.indexOf("m: 'self-fetch'");
	assert.ok(log > 0, 'logged');
	assert.equal((f.match(/m: 'self-fetch'/g) || []).length, 1, 'one line for every outcome');
	for (const t of ['throw signal.reason', 'throw err', 'throw new Error(SELF_REFUSAL_SAME_ISOLATE)']) assert.ok(f.indexOf(t) > log, t + ' comes after the line');
	assert.match(f, /outcome, status: r \? r\.status : null, ms: Date\.now\(\) - t0/);
	assert.doesNotMatch(f, /picker\.pick\(\)/, 'no random pool pick');
});
