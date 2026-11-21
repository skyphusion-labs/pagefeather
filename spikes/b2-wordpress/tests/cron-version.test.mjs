// node --test spikes/b2-wordpress/tests/cron-version.test.mjs (#1152)
// After a deploy, approach A's cron Durable Object kept running the PREVIOUS version for minutes (strummer, cf759hx:
// all 10 legs on 7e8f8f38 while the site ran 48a7fdd0 at 100%), so a merged cron fix (#1146) did not run. The Workers
// Cron Trigger tick runs in the site Worker, on the new version: it now sends its BUILD_ID. The cron object records a
// differing build, and at the START of its next alarm (after the next tick is armed, before any claim, with no PHP run
// in flight) it resets itself (ctx.abort), so the next event starts on the new code. The lead's guards: never mid-leg;
// at most one abort per 10 minutes (a gradual or split deployment sends ticks from both versions: no flapping); a
// cron-version-abort line with both ids.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cronTickRequest, cronVersionAbort, CRON_BUILD_HEADER, VERSION_ABORT_GAP_MS } from '../a-cron.mjs';
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('#1152 the tick carries the Worker build', () => {
	const PhpRuntime = { idFromName: (n) => n, get: () => ({}) };
	const { req } = cronTickRequest('https://s.example', { PhpRuntime, build: 'b27cd3c-x' });
	assert.equal(req.headers.get(CRON_BUILD_HEADER), 'b27cd3c-x');
	assert.equal(cronTickRequest('https://s.example', { PhpRuntime }).req.headers.get(CRON_BUILD_HEADER), null, 'no build: no header');
});
test('#1152 cronVersionAbort: abort when the object build differs from the tick build, at most once per 10 minutes', () => {
	const now = 10_000_000;
	assert.equal(VERSION_ABORT_GAP_MS, 10 * 60 * 1000);
	assert.equal(cronVersionAbort({ own: 'old', tick: 'new', lastAbortAt: undefined, now }), true);
	assert.equal(cronVersionAbort({ own: 'new', tick: 'new', lastAbortAt: undefined, now }), false, 'same build');
	assert.equal(cronVersionAbort({ own: 'old', tick: '', lastAbortAt: undefined, now }), false, 'no tick build (an older Worker)');
	assert.equal(cronVersionAbort({ own: '', tick: 'new', lastAbortAt: undefined, now }), false, 'no own build');
	assert.equal(cronVersionAbort({ own: 'old', tick: 'new', lastAbortAt: now - 60_000, now }), false, 'aborted a minute ago: wait');
	assert.equal(cronVersionAbort({ own: 'old', tick: 'new', lastAbortAt: now - VERSION_ABORT_GAP_MS, now }), true, '10 minutes on: again');
});
test('#1152 no flapping: during a split, ticks from both versions reset the object at most once per 10 minutes', () => {
	// A gradual deployment: ticks alternate builds every minute for an hour; the object flips with each reset.
	let own = 'A', last, aborts = 0;
	for (let m = 0; m < 60; m++) {
		const tick = m % 2 ? 'A' : 'B', now = m * 60_000 + 1;
		if (cronVersionAbort({ own, tick, lastAbortAt: last, now })) { aborts++; last = now; own = tick; }
	}
	assert.ok(aborts <= 6, 'at most one per 10 minutes: ' + aborts);
});
test('#1152 index.js: the scheduled tick sends BUILD_ID, the tick records a differing build, and the alarm acts only at its start', () => {
	assert.match(src, /return approachACronScheduled\(event, env, ctx, siteOrigin, BUILD_ID\);/);
	assert.match(src, /const tickBuild = raw\.headers\.get\(CRON_BUILD_HEADER\);/);
	assert.match(src, /if \(tickBuild && tickBuild !== BUILD_ID\) await this\.ctx\.storage\.put\(CRON_VERSION_PENDING_KEY, \{ build: tickBuild, at: Date\.now\(\) \}\);/);
	const a = src.indexOf('	async alarm() {');
	const arm = src.indexOf('this.tickAt = await armBeforeRun(', a);
	const check = src.indexOf('cronVersionAbort({ own: BUILD_ID', a);
	const firstTry = src.indexOf('		try {', a);
	assert.ok(arm > a && check > arm && check < firstTry, 'after the next tick is armed, before the leg (its try)');
	const body = src.slice(check - 400, check + 900);
	assert.match(body, /phpPending === 0/, 'never with a PHP run in flight');
	assert.match(body, /console\.log\(JSON\.stringify\(\{ '@event': 'cron-version-abort', m: 'cron-version-abort', own: BUILD_ID, tick: vp\.build \}\)\);/);
	assert.match(body, /this\.ctx\.abort\('cron-version'\);/);
	assert.match(body, /await this\.ctx\.storage\.put\(CRON_VERSION_ABORT_KEY, Date\.now\(\)\);/, 'the rate limit is stored before the reset');
});
test('#1152 /_cron-build (spike token): the Worker reports its build and the cron object\'s, for a deploy readback', () => {
	const gate = src.lastIndexOf("if (url.pathname.startsWith('/_') && !spikeOk) return new Response('forbidden', { status: 403 });");
	const route = src.indexOf("if (url.pathname === CRON_BUILD_PATH) {");
	assert.ok(gate > 0 && route > gate, 'after the A Worker spike gate');
	const body = src.slice(route, route + 900);
	assert.match(body, /env\.PHP_RUNTIME\.get\(env\.PHP_RUNTIME\.idFromName\(CRON_OBJECT_NAME\)\)/);
	assert.match(body, /new Request\('https:\/\/do\.internal\/_build'/);
	assert.match(body, /Response\.json\(\{ worker: BUILD_ID, cron: /);
});

// #1152 proof (strummer, cf759hx deploy 2): /_cron-build read "ok, on the deployed build" about 4 s BEFORE the abort,
// while the cron legs still ran the old version. The code that answers a request is not the code that runs the legs.
// The object now reports the build its last ALARM ran on (written by the alarm's own code from its baked-in BUILD_ID,
// never from a tick), and the state is ok only when the Worker, the answering code and the last alarm all agree.
test('#1152 cronBuildState: ok only when the worker, the object and its last alarm are one build', async () => {
	const { cronBuildState } = await import('../a-cron.mjs');
	assert.equal(cronBuildState({ worker: 'new', cron: 'new', alarm: 'new' }), 'ok');
	assert.equal(cronBuildState({ worker: 'new', cron: 'new', alarm: 'old' }), 'legs-stale', 'the strummer case: answering code new, legs old');
	assert.equal(cronBuildState({ worker: 'new', cron: 'new', alarm: null }), 'legs-stale', 'no alarm on record yet is not ok');
	assert.equal(cronBuildState({ worker: 'new', cron: 'old', alarm: 'old' }), 'object-stale');
	assert.equal(cronBuildState({ worker: null, cron: 'new', alarm: 'new' }), 'unknown');
	assert.equal(cronBuildState({ worker: 'new', cron: null, alarm: null }), 'unknown');
});
test('#1152 index.js: the alarm records its OWN BUILD_ID first, /_build reports it, /_cron-build uses cronBuildState', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /\tasync alarm\(\) \{\n\t\t\/\/ #1152[^\n]*\n(\t\t\/\/[^\n]*\n)*\t\tawait this\.ctx\.storage\.put\(CRON_ALARM_BUILD_KEY, \{ build: BUILD_ID, at: Date\.now\(\) \}\);/);
	assert.match(src, /if \(url\.pathname === '\/_build'\) \{ const ab = await this\.ctx\.storage\.get\(CRON_ALARM_BUILD_KEY\); return Response\.json\(\{ build: BUILD_ID, alarmBuild: \(ab && ab\.build\) \|\| null, alarmAt: \(ab && ab\.at\) \|\| null,/);
	assert.match(src, /state: cronBuildState\(\{ worker: BUILD_ID, cron, alarm \}\), same: cronBuildState\(\{ worker: BUILD_ID, cron, alarm \}\) === 'ok'/);
	assert.doesNotMatch(src, /CRON_ALARM_BUILD_KEY, \{ build: (tick|vp)/, 'never a value a tick wrote');
});
