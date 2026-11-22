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
	assert.match(src, /const self = selfFetchRoute\(\{ sameHost: isSelfHost\(url\), inObject: Boolean\(ocCtx && ocCtx\.inObject\), overflowed: Boolean\(ocCtx && ocCtx\.overflowed\), poolAvailable: selfFetchPoolAvailable\(ENV, ovs\), capped: overHeld\(ovs, ovHeld\)(, cacheAvailable: Boolean\(ocCtx && !ocCtx\.inObject && ocCtx\.exports && ocCtx\.exports\.Pages\))? \}\);/); // #1157 after #1298: cacheAvailable is the one input added, last
	assert.match(src, /res = self\.route === 'pool' \? \(await selfFetchFromCache\(url, method, headers, signal\)\) \|\| \(await selfFetchOnPool\(url, method, headers, body, signal\)\) : (self\.route === 'cache' \? await selfFetchCacheOrRefuse\(url, method, headers, signal, self\.missWhy\) : )?await fetch\(url, \{ method, headers, body, redirect: 'manual', signal \}\);/); // #1170 lever: the cache first; #1157 after #1298: the cache route between
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

// #1170 lever (the lead's ruling): a guest self-GET (no WordPress cookie, no auth: url-details sends none) is served from
// the front page cache when the page is cached there. A cache MISS must not render through Pages: Pages would run PHP in
// this isolate, behind the request that asked. The hop carries SELF_CACHE_ONLY_HEADER; Pages answers it at once with a
// no-store miss before any PHP, and the hop goes to ovf-self as before. A hit never reaches code.
test('#1170 lever: the cache-only miss answer is fast, never stored, and marked', async () => {
	const { selfCacheMissResponse, SELF_CACHE_MISS_HEADER } = await import('../self-fetch.mjs');
	const r = selfCacheMissResponse();
	assert.equal(r.status, 504);
	assert.equal(r.headers.get(SELF_CACHE_MISS_HEADER), '1');
	assert.match(r.headers.get('cache-control') || '', /no-store/);
});
test('#1170 lever index.js: Pages answers a cache-only request before site.fetch; the gateway strips a client copy; the hop tries the cache first', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const pages = src.slice(src.indexOf('export class Pages extends WorkerEntrypoint {'), src.indexOf('export class Pages extends WorkerEntrypoint {') + 800);
	const only = pages.indexOf('if (req.headers.get(SELF_CACHE_ONLY_HEADER) === \'1\') return selfCacheMissResponse();');
	assert.ok(only > 0 && only < pages.indexOf('await site.fetch(req, this.env, this.ctx)'), 'before any PHP');
	assert.match(src, /if \(pageCacheRoute\(req, url, env\)\) \{\n\t+const h = new Headers\(req\.headers\);\n\t+h\.delete\('cookie'\);\n\t+h\.delete\('authorization'\);\n\t+h\.delete\(SELF_CACHE_ONLY_HEADER\);/, 'the gateway never forwards a client marker');
	assert.match(src, /res = self\.route === 'pool' \? \(await selfFetchFromCache\(url, method, headers, signal\)\) \|\| \(await selfFetchOnPool\(url, method, headers, body, signal\)\) :/);
	const f = src.slice(src.indexOf('async function selfFetchFromCache('), src.indexOf('async function selfFetchOnPool('));
	assert.match(f, /if \(!pageCacheRoute\(req, url, ENV\)\) return null;/, 'the gateway rule decides eligibility');
	assert.match(f, /h\.set\(SELF_CACHE_ONLY_HEADER, '1'\);/);
	assert.match(f, /pageVersions\.pageVersionsOn\(ENV, dbHandler\) \? await versionedPagesRequest\(req, h, ENV\)/, 'the same versioned cache key as the gateway');
	assert.match(f, /outcome: 'cache-hit'/);
});

// #1226: a refused self-fetch returns in the hop check, before selfFetchOnPool, so it logged no
// self-fetch line. A count of 0 lines could not tell a refusal from a hop never sent. Each same-host
// refusal exit (guard, object, no pool, held cap) logs exactly one line, with the reason, and with
// no body and no query string.
test('#1226 index.js: every hop-check refusal for the site own host logs one self-fetch line', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const hopStart = src.indexOf('const self = selfFetchRoute({ sameHost: isSelfHost(url)');
	const hopEnd = src.indexOf("res = self.route === 'pool'", hopStart);
	assert.ok(hopStart > 0 && hopEnd > hopStart, 'the hop check');
	const hop = src.slice(hopStart, hopEnd);
	assert.equal((hop.match(/return out;/g) || []).length, 1, 'the four refusal reasons share one exit');
	const ret = hop.indexOf('return out;');
	const lines = hop.split('\n').filter((l) => l.includes("m: 'self-fetch'") && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
	assert.equal(lines.length, 1, 'exactly one self-fetch line on that exit');
	const logAt = hop.indexOf(lines[0]);
	assert.ok(logAt > 0 && logAt < ret, 'the line is logged before the return');
	assert.match(lines[0], /self\.route === 'refuse'/);
	assert.match(lines[0], /console\.log\(JSON\.stringify\(\{ m: 'self-fetch', outcome: 'refused', why, method, path: url\.pathname, iso: ISOLATE_ID, parent: runCallId \}\)\)/);
	assert.doesNotMatch(lines[0], /search|\.href|\bbody\b|query/, 'no body and no query string');
	// Each refusal reason is the why on that one line. An outbound host refusal is not a self-fetch.
	const exits = [
		[{ ...base, inObject: true, overflowed: true }, SELF_REFUSAL_GUARD],
		[{ ...base, inObject: true }, SELF_REFUSAL_OBJECT],
		[{ ...base, poolAvailable: false }, SELF_REFUSAL_NO_POOL],
		[{ ...base, capped: true }, SELF_REFUSAL_CAPPED],
	];
	for (const [input, why] of exits) {
		const r = selfFetchRoute(input);
		assert.equal(r.route, 'refuse', why);
		assert.equal(r.why, why);
	}
	assert.match(hop, /self\.route === 'refuse' \? self\.why/, 'the exit logs that why');
	assert.match(hop, /self\.route === 'out' \? httpRefusal\(url\)/, 'an outbound refusal stays on the http line only');
});

// #1157 after #1298 (the pool off by default): httpHop decided "refuse" before the cache was tried, so EVERY self-fetch
// was refused, a page already in the front page cache included. The cache path needs no pool (#1170: url-details 200
// in 1.3 to 1.6 s on cf759hx, every hop a cache hit, ovf-self never booted). With no pool but the Pages export, the hop
// tries the cache; only a miss is refused, with the same reason.
test('#1157 no pool but the Pages export: the cache route, and a miss keeps the no-pool reason', () => {
	assert.deepEqual(selfFetchRoute({ ...base, poolAvailable: false, cacheAvailable: true }), { route: 'cache', missWhy: SELF_REFUSAL_NO_POOL });
	assert.deepEqual(selfFetchRoute({ ...base, poolAvailable: false }), { route: 'refuse', why: SELF_REFUSAL_NO_POOL }, 'no Pages export: refused, as before');
	assert.deepEqual(selfFetchRoute({ ...base, cacheAvailable: true }), { route: 'pool' }, 'with the pool: the pool route, which tries the cache first');
});
test('#1157 the guards come first: in an object, or on a pool request, the cache route is never taken', () => {
	assert.deepEqual(selfFetchRoute({ ...base, poolAvailable: false, cacheAvailable: true, inObject: true }), { route: 'refuse', why: SELF_REFUSAL_OBJECT });
	assert.deepEqual(selfFetchRoute({ ...base, poolAvailable: false, cacheAvailable: true, inObject: true, overflowed: true }), { route: 'refuse', why: SELF_REFUSAL_GUARD });
	assert.equal(selfFetchRoute({ ...base, sameHost: false, cacheAvailable: true }).route, 'out');
});
test('#1157 index.js: the hop passes cacheAvailable from the Pages export, and a cache-route miss logs the refusal and throws it', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /selfFetchRoute\(\{ sameHost: isSelfHost\(url\),[^}]*cacheAvailable: Boolean\(ocCtx && !ocCtx\.inObject && ocCtx\.exports && ocCtx\.exports\.Pages\)/);
	assert.match(src, /: self\.route === 'cache' \? await selfFetchCacheOrRefuse\(url, method, headers, signal, self\.missWhy\) :/);
	const f = src.slice(src.indexOf('async function selfFetchCacheOrRefuse('), src.indexOf('async function selfFetchOnPool('));
	assert.ok(f.length > 0, 'the helper exists, beside selfFetchFromCache');
	assert.match(f, /const r = await selfFetchFromCache\(url, method, headers, signal\);/);
	assert.match(f, /if \(r\) return r;/);
	assert.match(f, /m: 'self-fetch', outcome: 'refused', why: missWhy, method, path: url\.pathname, iso: ISOLATE_ID, parent: runCallId/);
	assert.match(f, /throw new Error\(missWhy\);/);
	assert.ok(f.indexOf("outcome: 'refused'") < f.indexOf('throw new Error(missWhy);'), 'logged before the throw');
});

// #1157 (strummer's export, 2026-11-22): the two failing url-details calls each matched ONE req line and no hop line,
// so a hop could not be tied to the request that asked. The self-fetch lines carry parent since #1170 and #1226; the
// bridge's own http line did not. Every http line now names the request it ran for.
test('#1157 index.js: the http bridge line names its parent request (parent: runCallId)', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const lines = src.split('\n').filter((l) => /console\.log\(JSON\.stringify\(\{ m: 'http',/.test(l));
	assert.ok(lines.length >= 1, 'the http line exists');
	for (const l of lines) assert.match(l, /parent: runCallId/, l.trim().slice(0, 120));
});
