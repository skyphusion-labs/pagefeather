// #708: a request still QUEUED in a PHP object when its caller has given up must never run (a checkout would commit
// after the shopper saw a failure). The object cannot rely on seeing the caller's abort (request.signal reaches a fetch
// handler only with enable_request_signal, and Cloudflare does not say a Durable Object sees its caller's stub.fetch
// abort). So the Worker stamps a start-by on each forwarded request, and the object sheds (never runs) a request not
// granted by then: the lock's pre-run shed is provably "not run". #703's deadline then bounds only started runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startByMs, objectShedPlan, startByResponse, START_BY_HEADER, CALL_HEADER, tagCallId, startByExempt, shedAnswer, recheckStartBy, CLOCK_LAG_MAX_MS, disconnectAnswer, disconnectSignal, tickFetch, tickResponse, TICK_PATH } from '../start-by.mjs';

test('startByMs: the default is the deadline minus a run allowance (30 s, or a third of a short deadline)', () => {
	assert.equal(startByMs({}, 90000), 60000);
	assert.equal(startByMs({}, 30000), 20000);
	assert.equal(startByMs({}, 600000), 570000);
	assert.equal(startByMs({}, 0), 0, 'no deadline (OBJECT_CALL_DEADLINE_S=off) and no explicit value: no start-by');
});
test('startByMs: OBJECT_START_BY_S sets it (seconds), off turns it off, a bad value keeps the default', () => {
	assert.equal(startByMs({ OBJECT_START_BY_S: '45' }, 90000), 45000);
	assert.equal(startByMs({ OBJECT_START_BY_S: 'off' }, 90000), 0);
	for (const bad of ['', 'abc', '-5', '0', '1e9', '10s']) assert.equal(startByMs({ OBJECT_START_BY_S: bad }, 90000), 60000, bad);
	// A start-by later than the deadline would let the deadline catch a request that never started: it is clamped.
	assert.equal(startByMs({ OBJECT_START_BY_S: '120' }, 90000), 60000);
	// #708 review 6: an explicit value stands on its own when #703's deadline is off (OBJECT_CALL_DEADLINE_S=off), so a
	// queued request still never runs after its caller gave up. With no deadline there is no ceiling to clamp to.
	assert.equal(startByMs({ OBJECT_START_BY_S: '45' }, 0), 45000, 'explicit, deadline off: honoured');
	assert.equal(startByMs({ OBJECT_START_BY_S: '700' }, 0), 0, 'a bad value with no deadline: none (still bounded to 600 s)');
	assert.equal(startByMs({}, 0), 0, 'deadline off and no explicit value: no start-by (unchanged)');
	assert.equal(startByMs({ OBJECT_START_BY_S: '45' }, 90000, { exempt: true }), 0, 'an exempt path (install, import, cron) never gets one');
});
test('objectShedPlan: no or a bad start-by header keeps the base shed (today)', () => {
	assert.deepEqual(objectShedPlan(null, 1000, 0), { refuseNow: false, shedMs: 0, byStartBy: false, startBy: 0 });
	assert.deepEqual(objectShedPlan('abc', 1000, 5000), { refuseNow: false, shedMs: 5000, byStartBy: false, startBy: 0 });
});
test('objectShedPlan: a start-by already past refuses at once; otherwise the remainder becomes the shed bound', () => {
	assert.deepEqual(objectShedPlan('1000', 1000, 0), { refuseNow: true, shedMs: 0, byStartBy: true, startBy: 1000 });
	assert.deepEqual(objectShedPlan('900', 1000, 0), { refuseNow: true, shedMs: 0, byStartBy: true, startBy: 900 });
	assert.deepEqual(objectShedPlan('61000', 1000, 0), { refuseNow: false, shedMs: 60000, byStartBy: true, startBy: 61000 });
	// With PHP_QUEUE_SHED_MS also set (#635), the tighter bound wins, and says which one it is.
	assert.deepEqual(objectShedPlan('61000', 1000, 30000), { refuseNow: false, shedMs: 30000, byStartBy: false, startBy: 61000 });
	assert.deepEqual(objectShedPlan('11000', 1000, 30000), { refuseNow: false, shedMs: 10000, byStartBy: true, startBy: 11000 });
});
test('startByResponse: a fast, retry-safe 503 that says the request was queued and never ran', async () => {
	const r = startByResponse();
	assert.equal(r.status, 503);
	assert.equal(r.headers.get('x-object-deadline'), 'queued');
	assert.equal(r.headers.get('x-write-loss'), 'none');
	assert.equal(r.headers.get('retry-after'), '5');
	assert.match(r.headers.get('cache-control') || '', /no-store/);
	assert.equal(r.headers.get('cloudflare-cdn-cache-control'), 'no-store', 'review 3: noStoreAnywhere, never stored at the edge');
	assert.equal(r.headers.get('x-overloaded'), '1', 'review 4: overloaded, as phpShedResponse says');
	assert.match(await r.text(), /try again/i);
});
test('the header names', () => {
	assert.equal(START_BY_HEADER, 'x-pf-start-by');
	assert.equal(CALL_HEADER, 'x-pf-call');
});
test('index.js wires it on both sides (index.js imports the wasm engine, so it cannot load here)', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	// review 8: the Worker strips client copies of both headers on EVERY path, first thing in serve(), so neither the
	// object path nor the Worker's own PHP (WordPress would see HTTP_X_PF_*) ever gets a client's value.
	const serve = src.slice(src.indexOf('	async serve(req, env, ctx) {'), src.indexOf("if (url.pathname === '/_ping')"));
	assert.ok(/req\.headers\.has\(START_BY_HEADER\) \|\| req\.headers\.has\(CALL_HEADER\)/.test(serve) && /delete\(START_BY_HEADER\)/.test(serve) && /delete\(CALL_HEADER\)/.test(serve), 'serve() strips both first');
	// The forward sets the call id, and the start-by or none (review 9: no delete before a set).
	assert.ok(/fwd\.headers\.set\(CALL_HEADER, callId\);/.test(src), 'the forward carries the call id');
	assert.ok(/if \(startByQ > 0\) fwd\.headers\.set\(START_BY_HEADER, String\(t0 \+ startByQ\)\);\s*else fwd\.headers\.delete\(START_BY_HEADER\);/.test(src), 'a start-by, or none');
	assert.ok(!/fwd\.headers\.delete\(CALL_HEADER\);\s*fwd\.headers\.set\(CALL_HEADER/.test(src), 'review 9: no delete-then-set');
	// review 5: the client sees the call id on every answer of the object path (the wrapper tags what comes back).
	assert.ok(/async function toPhpObject\(req, env, url, ctx, target = null\) \{[\s\S]{0,400}tagCallId\(/.test(src), 'toPhpObject tags its answer');
	// review 7: a request refused on arrival writes nothing: the refusal comes before the origin write and the cron rearm.
	const obj = src.slice(src.indexOf('	async fetch(raw) {'));
	const refuse = obj.indexOf('startByResponse()'); const write = obj.indexOf('this.ctx.storage.put(ORIGIN_KEY, origin)');
	assert.ok(refuse > 0 && write > 0 && refuse < write, 'the arrive-time refusal precedes any storage write');
	assert.ok(/objectShedPlan\(/.test(obj) && /req\.headers\.delete\(START_BY_HEADER\)/.test(obj) && /req\.headers\.delete\(CALL_HEADER\)/.test(obj), 'the object plans, and PHP never sees the headers');
	// review 2: the call id rides on the per-request ctx, not a module global (overlapping runs after a stale takeover).
	assert.ok(!/^let currentCall\b/m.test(src), 'no module-level currentCall');
	assert.ok(/ctx\.callId = callId/.test(obj) && /ctx && ctx\.callId \? \{ call: ctx\.callId \}/.test(src), 'perf reads ctx.callId');
	// The correlation id is on the Worker's overflow and deadline lines.
	assert.ok(/event: 'overflow', [^\n]*call:/.test(src), 'overflow line carries call');
	assert.ok(/m: 'object-deadline', [^\n]*call:/.test(src), 'deadline line carries call');
});

// #715 second review.
test('review2 1: the call id rides only on answers no cache can keep (the edge would replay one request\'s id on every hit)', () => {
	const page = new Response('<html>', { status: 200, headers: { 'cache-control': 'public, max-age=300' } });
	assert.equal(tagCallId(page, 'c1').headers.get(CALL_HEADER), null, 'a cacheable page is not tagged');
	const bare = new Response('<html>', { status: 200 });
	assert.equal(tagCallId(bare, 'c1').headers.get(CALL_HEADER), null, 'no cache-control: not tagged');
	for (const cc of ['no-store', 'private, no-store']) {
		const r = new Response('x', { status: 503, headers: { 'cache-control': cc } });
		assert.equal(tagCallId(r, 'c2').headers.get(CALL_HEADER), 'c2', cc);
	}
	assert.equal(tagCallId(startByResponse(), 'c3').headers.get(CALL_HEADER), 'c3', 'the start-by answer is tagged');
	// An immutable answer (as stub.fetch may return) is copied once, and tagged.
	const im = new Response('x', { status: 500, headers: { 'cache-control': 'no-store' } });
	const frozen = new Proxy(im, { get: (t, k) => (k === 'headers' ? new Proxy(t.headers, { get: (h, kk) => (kk === 'set' ? () => { throw new TypeError('immutable'); } : Reflect.get(h, kk).bind ? Reflect.get(h, kk).bind(h) : Reflect.get(h, kk)) }) : Reflect.get(t, k)) });
	const out = tagCallId(frozen, 'c4');
	assert.equal(out.headers.get(CALL_HEADER), 'c4');
});
test('review2 6: operator and control paths (/_*) and the deadline-exempt paths never get a start-by', () => {
	for (const p of ['/_evict', '/_hold', '/_build', '/_purgestate', '/_dbexport', '/_mysqlexport', '/_dbcounts', '/_snapshot', '/_install', '/_activate', '/_runcron', '/wp-cron.php'])
		assert.equal(startByExempt(p), true, p);
	for (const p of ['/', '/shop/', '/wp-admin/admin-ajax.php', '/wp-login.php', '/?rest_route=x'])
		assert.equal(startByExempt(new URL('https://x' + p).pathname), false, p);
	assert.equal(startByMs({}, 90000, { exempt: startByExempt('/_evict') }), 0, 'so a late /_evict is never refused');
});
test('review2 10: one shed answer for both sheds: never stored, overloaded, Retry-After 5, the given body and headers', async () => {
	const r = shedAnswer('busy\n', { 'x-php-lock': 'shed' });
	assert.equal(r.status, 503);
	assert.equal(r.headers.get('x-overloaded'), '1');
	assert.equal(r.headers.get('retry-after'), '5');
	assert.equal(r.headers.get('cloudflare-cdn-cache-control'), 'no-store');
	assert.equal(r.headers.get('x-php-lock'), 'shed');
	assert.equal(await r.text(), 'busy\n');
	const sb = startByResponse();
	for (const h of ['x-overloaded', 'retry-after', 'cloudflare-cdn-cache-control', 'x-php-lock']) assert.equal(sb.headers.get(h), r.headers.get(h), h);
});
test('review2 wiring: one arrival refusal and no write before the run; the shed says why; the call id on overflow-local; the deadline line names its answer', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const obj = src.slice(src.indexOf('	async fetch(raw) {'), src.indexOf('function phpObjectName('));
	// review2 5 and 9: exactly one refusal, and the origin write and the cron rearm happen INSIDE the run (a shed never writes).
	assert.equal(obj.split('startByResponse()').length - 1, 2, 'one arrival refusal, one lock-shed answer');
	const run = obj.indexOf('const objectRun = await withPhp(');
	const put = obj.indexOf('this.ctx.storage.put(ORIGIN_KEY, origin)');
	const refuse = obj.indexOf('if (plan.refuseNow || gone) {');
	const rearmAt = obj.indexOf('await rearm(this.ctx.storage');
	// review3 2: OUTSIDE the PHP lock (storage I/O must not delay grants), and only after the refusal (review2 5).
	assert.ok(refuse > 0 && put > refuse && put < run && rearmAt > refuse && rearmAt < run, 'the origin write and the rearm are after the refusal and outside the lock');
	assert.ok(/shedWhy: plan\.byStartBy \? 'start-by' : 'queue-shed'/.test(obj), 'review2 8: the shed says why');
	assert.ok(/event: 'overflow-local', [^\n]*call:/.test(src), 'review2 8: overflow-local carries the call id');
	assert.ok(/m: 'object-deadline', [^\n]*answered:/.test(src), 'review2 3: the deadline line names its answer');
	assert.ok(/startByExempt\(url\.pathname\)/.test(src), 'review2 6: the Worker exempts control paths');
	assert.ok(/tagCallId\(r, callId\)/.test(src) && !/^function withCallHeader/m.test(src), 'review2 1: the module rule tags, not a local helper');
});
test('review2 10: the seconds parser is shared with #703 (no second regex in start-by.mjs)', () => {
	const sb = readFileSync(new URL('../start-by.mjs', import.meta.url), 'utf8');
	assert.ok(/import \{[^}]*secondsMs[^}]*\} from '\.\/object-deadline\.mjs'/.test(sb), 'start-by imports the shared parser');
	assert.ok(!/\/\^\[0-9\]\+/.test(sb), 'and has no parser of its own');
});

test('review2 4: a request granted on a stale clock reads it again after a tick, and sheds when its start-by has passed', async () => {
	// Date.now() moves only at I/O: the grant can read a clock that is behind. The tick lets it move.
	let t = 1000; const tickTo = (v) => async () => { t = v; };
	let r = await recheckStartBy(5000, { now: () => t, tick: tickTo(7000) });
	assert.deepEqual(r, { late: true, clockMs: 6000, why: 'start-by', tick: 'ok' }, 'the fresh clock is past the start-by: shed');
	t = 1000;
	r = await recheckStartBy(5000, { now: () => t, tick: tickTo(4000) });
	assert.deepEqual(r, { late: false, clockMs: 3000, tick: 'ok' }, 'still before the start-by: run');
	t = 1000;
	r = await recheckStartBy(5000, { now: () => t, tick: async () => {} });
	assert.deepEqual(r, { late: true, why: 'tick-failed', clockMs: 0, tick: 'ok' }, '#754: a tick that does not move the clock leaves it unknown: shed');
	// The default tick is one timer turn.
	t = 6000;
	r = await recheckStartBy(5000, { now: () => t });
	assert.equal(r.late, true);
});
test('review2 4 wiring: the object rechecks before the writes and before PHP, only when it queued behind another run', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const obj = src.slice(src.indexOf('	async fetch(raw) {'), src.indexOf('function phpObjectName('));
	const run = obj.indexOf('const objectRun = await withPhp(');
	// review3 5: the lock runs the recheck at its grant (php-lock.mjs recheck), through its own tagged logger.
	assert.ok(/recheck: plan\.startBy > 0 \? async \(\) => \{[^\n]*recheckStartBy\(plan\.startBy, \{/.test(obj), 'the object hands the recheck to the lock');
	assert.ok(!/event: 'shed', at: 'clock'/.test(obj), 'and logs no shed line of its own');
});

// #715 third review.
test('review3 3: uncached is the Worker edge directive (cloudflare-cdn-cache-control), and a field form never fools it', () => {
	const tag = (h) => tagCallId(new Response('x', { headers: h }), 'c').headers.get(CALL_HEADER);
	assert.equal(tag({ 'cloudflare-cdn-cache-control': 'no-store', 'cache-control': 'no-cache, must-revalidate, max-age=0' }), 'c', 'an uncached page');
	assert.equal(tag({ 'cloudflare-cdn-cache-control': 'max-age=300, stale-while-revalidate=60', 'cache-control': 'no-cache' }), null, 'an edge-cached page, whatever WordPress said');
	assert.equal(tag({ 'cloudflare-cdn-cache-control': 'max-age=300', 'cache-control': 'private, no-store' }), null, 'the edge directive wins');
	assert.equal(tag({ 'cache-control': 'private="set-cookie", max-age=300' }), null, 'a private="..." field is not no-store');
	assert.equal(tag({ 'cache-control': 'no-store' }), 'c', 'a Worker failure answer (no edge directive): its own no-store');
	assert.equal(tag({ 'cache-control': 'x-no-store-ish' }), null, 'only the whole directive');
});
test('review3 4: the recheck ticks only when the start-by is within the possible clock lag; otherwise it grants at once', async () => {
	assert.equal(CLOCK_LAG_MAX_MS, 30000, 'the per-request CPU limit (the default; b-dosql sets none)');
	let ticks = 0; const tick = async () => { ticks++; };
	let r = await recheckStartBy(100000, { now: () => 1000, tick });
	assert.equal(ticks, 0, '99 s left: no tick');
	assert.equal(r.late, false);
	r = await recheckStartBy(20000, { now: () => 1000, tick });
	assert.equal(ticks, 1, '19 s left: one tick');
});
test('review3 7 and 8: one start-by parser (objectShedPlan returns it), no dead constant, no always-true guard', () => {
	assert.equal(objectShedPlan('5000', 1000, 0).startBy, 5000);
	assert.equal(objectShedPlan('5000', 6000, 0).startBy, 5000);
	for (const bad of [null, '', 'x', '-1', '0']) assert.equal(objectShedPlan(bad, 1000, 0).startBy, 0, String(bad));
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.ok(!/Number\(startByHeader\)/.test(src), 'index.js parses no start-by of its own');
	assert.ok(!/PHP_SHED_RETRY_AFTER_S/.test(src), 'the dead constant is gone');
	assert.ok(!/event: 'overflow-local'[^\n]*callId \?/.test(src), 'overflow-local: the id is always set there');
});

test('#721 wiring: the object hands its request.signal to the lock, refuses a request already gone, and every site Worker emitter sets the flag', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const obj = src.slice(src.indexOf('	async fetch(raw) {'), src.indexOf('function phpObjectName('));
	assert.ok(/signal: callerSignal,/.test(obj), 'the object passes its caller signal (disconnectSignal) to withPhp');
	assert.ok(/function withPhp\(fn, \{[^}]*signal = null[^}]*\} = \{\}\)/.test(src) && /\t\t\tsignal,[^\n]*\n/.test(src), 'withPhp forwards it to the lock');
	const refuse = obj.indexOf('if (plan.refuseNow || gone) {');
	assert.ok(/const gone = !!\(callerSignal && callerSignal\.aborted\);/.test(obj) && refuse > 0 && refuse < obj.indexOf('if (armsCron) {'), 'a request already gone is refused in the one arrival refusal, before the origin write');
	assert.ok(/why: gone \? 'disconnect' : 'start-by'/.test(obj), 'and says why');
	const root = new URL('../../../', import.meta.url);
	const files = ['spikes/b2-wordpress/wrangler.toml', 'deploy/render-conf.sh', 'deploy/wfp/lib.sh', 'deploy/provision/server-config.mjs', 'deploy/provision/cli.mjs', 'deploy/release/build-bundle.sh'];
	for (const f of files) {
		const t = readFileSync(new URL(f, root), 'utf8');
		assert.ok(/["']nodejs_compat["'], ?["']enable_request_signal["']/.test(t), f + ' sets enable_request_signal');
		assert.ok(!/compatibility_date = "2026-11|compatibilityDate: ['"]2026-11/.test(t), f + ': the specific flag, never a date bump');
	}
});

test('#721 audit: a caller gone mid-call gets a quiet 499 that is never stored and says what may have been written', { timeout: 3000 }, async () => {
	const post = disconnectAnswer('POST');
	assert.equal(post.status, 499);
	assert.equal(post.headers.get('x-write-loss'), 'unknown', 'a POST that started may have saved (the object run is never cancelled)');
	assert.equal(post.headers.get('cloudflare-cdn-cache-control'), 'no-store');
	assert.equal(disconnectAnswer('GET').headers.get('x-write-loss'), 'none');
});
test('#721 audit wiring: an unclassified error on a disconnected caller is answered, not thrown; container forwards detach the signal', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const fn = src.slice(src.indexOf('async function toPhpObjectCall('), src.indexOf('\n}\n', src.indexOf('async function toPhpObjectCall(')));
	const gone = fn.indexOf('if (req.signal && req.signal.aborted) return { gone: true };');
	const rethrow = fn.indexOf('if (!isObjectCallDeadline(e)) throw e;');
	assert.ok(gone > 0 && rethrow > gone, 'checked before the rethrow');
	assert.ok(/if \(res\.gone\) \{[^}]*m: 'disconnect'/.test(fn), 'logged as a disconnect, not an exception');
	// A disconnect must never abort a started write: a checkout in the container must not inherit the caller's signal.
	assert.ok(/checkoutContainer\(env\)\.fetch\(new Request\(req, \{ signal: null \}\)\)/.test(src), 'the checkout container forward detaches it');
	assert.ok(/checkoutContainer\(env\)\.fetch\(new Request\(inner, req\)/.test(src) === false && /new Request\(new Request\(inner, req\), \{ signal: null \}\)/.test(src), 'the spike container forward too');
});

// #721 escape hatch (the lead's rule: a new default needs one on every path). OBJECT_DISCONNECT_SHED=off: a queued
// waiter ignores its caller's signal and only the start-by applies. The compatibility flag stays on either way.
test('OBJECT_DISCONNECT_SHED: on by default; off hands the lock no signal, so a waiter whose caller is gone still runs', { timeout: 3000 }, async () => {
	const { createPhpLock, PHP_SHED } = await import('../php-lock.mjs');
	const ac = new AbortController(); ac.abort();
	assert.equal(disconnectSignal({}, ac.signal), ac.signal, 'unset: on');
	assert.equal(disconnectSignal({ OBJECT_DISCONNECT_SHED: 'on' }, ac.signal), ac.signal);
	assert.equal(disconnectSignal({ OBJECT_DISCONNECT_SHED: 'off' }, ac.signal), null, 'off: no signal');
	assert.equal(disconnectSignal({ OBJECT_DISCONNECT_SHED: 'bogus' }, ac.signal), ac.signal, 'a bad value keeps the default (the render refuses it)');
	const lock = createPhpLock({ log: () => {} });
	assert.equal(await lock.run(async () => 'ran', { signal: disconnectSignal({ OBJECT_DISCONNECT_SHED: 'off' }, ac.signal) }), 'ran', 'off: it runs');
	assert.equal(await lock.run(async () => 'ran', { signal: disconnectSignal({}, ac.signal) }), PHP_SHED, 'on: it sheds');
});
test('OBJECT_DISCONNECT_SHED wiring: the object takes both the lock signal and the arrival check from disconnectSignal', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const obj = src.slice(src.indexOf('	async fetch(raw) {'), src.indexOf('function phpObjectName('));
	assert.ok(/const callerSignal = disconnectSignal\(env, raw\.signal\);/.test(obj), 'one decision');
	assert.ok(/const gone = !!\(callerSignal && callerSignal\.aborted\);/.test(obj), 'the arrival check follows it');
	assert.ok(/signal: callerSignal,/.test(obj) && !/signal: raw\.signal,/.test(obj), 'the lock gets it, never raw.signal directly');
});

// #752: the recheck's tick is a REAL subrequest (measured on the edge: only a fetch moves Date.now() in a Durable Object;
// a timer turn, a storage read and the assets binding do not). The endpoint is the site's own front Worker, answered
// before any object call. A failed or slow tick sheds the waiter (the lead's ruling): an unknown clock must fail safe.
test('#752 tickFetch: GET <origin>/_tick; a 204 resolves; anything else, an error or a timeout rejects', { timeout: 5000 }, async () => {
	assert.equal(TICK_PATH, '/_tick');
	let seen = null;
	await tickFetch('https://s.example', { fetchImpl: async (u, init) => { seen = { u, m: init && init.method, sig: !!(init && init.signal) }; return new Response(null, { status: 204 }); } });
	assert.deepEqual(seen, { u: 'https://s.example/_tick', m: 'GET', sig: true });
	await assert.rejects(tickFetch('https://s.example', { fetchImpl: async () => new Response('x', { status: 500 }) }), /tick answered 500/);
	await assert.rejects(tickFetch('https://s.example', { fetchImpl: async () => { throw new Error('1042'); } }), /1042/);
	const hang = (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
	// Node's AbortSignal.timeout timer is unref'd: with nothing else pending, the event loop empties before it fires and
	// the runner cancels the test (CI, Node 22: "Promise resolution is still pending but the event loop has already
	// resolved"). A ref'd timer holds the loop open while the hung tick waits for its timeout. (The Workers runtime has no
	// unref; this is the test harness only.)
	const keep = setInterval(() => {}, 1000);
	try {
		const t0 = Date.now();
		await assert.rejects(tickFetch('https://s.example', { fetchImpl: hang, timeoutMs: 50 }));
		assert.ok(Date.now() - t0 < 2000, 'a hung tick is cut at its timeout');
	} finally {
		clearInterval(keep);
	}
});
test('#752 tickResponse: a 204 that no cache keeps', () => {
	const r = tickResponse();
	assert.equal(r.status, 204);
	assert.equal(r.headers.get('cloudflare-cdn-cache-control'), 'no-store');
});
test('#752 recheckStartBy: a failed tick SHEDS (why tick-failed); a caller gone after the tick sheds (why disconnect)', { timeout: 3000 }, async () => {
	let r = await recheckStartBy(5000, { now: () => 1000, tick: async () => { throw new Error('down'); } });
	assert.equal(r.late, true); assert.equal(r.why, 'tick-failed');
	const ac = new AbortController();
	r = await recheckStartBy(5000, { now: () => 1000, tick: async () => { ac.abort(); }, signal: ac.signal });
	assert.equal(r.late, true); assert.equal(r.why, 'disconnect', 'the abort is read AFTER the real I/O');
	// #754: a tick that settles on an UNMOVED clock leaves the clock unknown: shed (was: granted, before the lead's rule).
	r = await recheckStartBy(5000, { now: () => 1000, tick: async () => {} });
	assert.equal(r.late, true); assert.equal(r.why, 'tick-failed');
	let t = 1000;
	r = await recheckStartBy(5000, { now: () => t, tick: async () => { t = 9000; } });
	assert.equal(r.late, true); assert.equal(r.why, 'start-by');
});
test('#752 wiring: the front Worker answers /_tick FIRST; the object ticks against its own origin and passes its caller signal', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const entry = src.slice(src.lastIndexOf('export default {'));
	const tick = entry.indexOf('if (url.pathname === TICK_PATH) return tickResponse();');
	assert.ok(tick > 0 && tick < entry.indexOf('pageCacheRoute('), 'before the page cache, before any object call');
	const obj = src.slice(src.indexOf('	async fetch(raw) {'), src.indexOf('function phpObjectName('));
	assert.ok(/recheckStartBy\(plan\.startBy, \{ tick: \(\) => tickFetch\(tickUrl\(env, origin\), \{ full: true \}\), signal: callerSignal \}\)/.test(obj), 'a real tick (START_BY_TICK_URL or the own origin), with the caller signal');
});

// #754 live proof: the self-fetch was refused, yet the failed attempt still MOVED the clock (clockMs 12.5 to 20.8 s). The
// lead's rule: after the tick SETTLES (ok or error), decide by the start-by on the re-read clock. tick-failed ONLY when the
// clock did not advance across the tick: then it is truly unknown, and the waiter sheds (fail safe).
test('#754 rule: a failed tick that MOVED the clock decides by the start-by; only an unmoved clock is tick-failed', { timeout: 3000 }, async () => {
	let t = 1000;
	const failMoving = (to) => async () => { t = to; throw new Error('refused 1042'); };
	// A HEALTHY waiter that still TICKS: under 30 s left on the stale clock (so it ticks), time left on the true one.
	let r = await recheckStartBy(25000, { now: () => t, tick: failMoving(16000) });
	assert.equal(r.late, false, 'a healthy waiter (9 s really left) is granted, not falsely shed');
	assert.equal(r.tick, 'error'); assert.match(r.err, /1042/);
	t = 1000; r = await recheckStartBy(10000, { now: () => t, tick: failMoving(16000) });
	assert.equal(r.late, true); assert.equal(r.why, 'start-by', 'late by the moved clock: start-by, not tick-failed');
	t = 1000; r = await recheckStartBy(10000, { now: () => t, tick: async () => { throw new Error('no io'); } });
	assert.equal(r.late, true); assert.equal(r.why, 'tick-failed', 'the clock did not move: unknown, shed');
	t = 1000; r = await recheckStartBy(25000, { now: () => t, tick: async () => { t = 16000; } });
	assert.equal(r.late, false); assert.equal(r.tick, 'ok'); assert.equal(r.err, undefined);
	// 30 s or more left even on the stale clock: no tick at all (#715 review3 4), granted at once.
	t = 1000; let ticked = false; r = await recheckStartBy(60000, { now: () => t, tick: async () => { ticked = true; } });
	assert.equal(r.late, false); assert.equal(ticked, false);
});
test('#754 the tick target: START_BY_TICK_URL when set (a dedicated Worker), else the site origin + /_tick', async () => {
	const { tickUrl } = await import('../start-by.mjs');
	assert.equal(tickUrl({}, 'https://s.example'), 'https://s.example/_tick');
	assert.equal(tickUrl({ START_BY_TICK_URL: 'https://tick.example.workers.dev/' }, 'https://s.example'), 'https://tick.example.workers.dev/');
	assert.equal(tickUrl({ START_BY_TICK_URL: 'http://plain.example/' }, 'https://s.example'), 'https://s.example/_tick', 'only https is taken');
	let seen = null;
	await tickFetch('https://tick.example.workers.dev/', { fetchImpl: async (u) => { seen = u; return new Response(null, { status: 204 }); }, full: true });
	assert.equal(seen, 'https://tick.example.workers.dev/');
});
