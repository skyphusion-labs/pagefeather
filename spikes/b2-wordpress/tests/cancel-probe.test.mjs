// node --test spikes/b2-wordpress/tests/cancel-probe.test.mjs (#1359, measure first)
// Does a client cancel stop a request's outstanding work, and does ctx.waitUntil keep it alive? On cf759hl (#1277 arm
// (b)) every stuck PHP lock head began with a client-CANCELED invocation and made no progress again. The probe answers
// it on the real platform: an operator-only route that awaits (a timer, or a database SLEEP) and logs when the await
// finishes, held by the request alone or also by ctx.waitUntil. A client that hangs up after 1 s shows which logs fire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fakeCtx = () => { const held = []; return { held, waitUntil: (p) => held.push(p) }; };
test('#1359 cancelProbe: off unless CANCEL_PROBE=on and the spike token is valid', async () => {
	const m = await import('../cancel-probe.mjs');
	assert.equal(m.cancelProbeAllowed({}, true), false, 'flag off');
	assert.equal(m.cancelProbeAllowed({ CANCEL_PROBE: 'on' }, false), false, 'no spike token');
	assert.equal(m.cancelProbeAllowed({ CANCEL_PROBE: 'on' }, true), true);
});
test('#1359 cancelProbe: logs start, fired and answered; hold=waituntil registers the work with ctx.waitUntil', async () => {
	const m = await import('../cancel-probe.mjs');
	const lines = [];
	const ctx = fakeCtx();
	const r = await m.cancelProbe(new URL('https://x.example/_cancel-probe?id=t1&kind=timer&hold=waituntil&ms=5'), ctx, { log: (o) => lines.push(o), dbOneShot: null });
	assert.equal(r.status, 200);
	assert.deepEqual(lines.map((l) => l.phase), ['start', 'fired', 'answered']);
	assert.ok(lines.every((l) => l.m === 'cancel-probe' && l.id === 't1' && l.kind === 'timer' && l.hold === 'waituntil'));
	assert.equal(ctx.held.length, 1, 'the await is held by waitUntil');
	const ctx2 = fakeCtx();
	await m.cancelProbe(new URL('https://x.example/_cancel-probe?id=t2&kind=timer&hold=request&ms=5'), ctx2, { log: () => {}, dbOneShot: null });
	assert.equal(ctx2.held.length, 0, 'hold=request: the request alone holds it');
});
test('#1359 cancelProbe: kind=db awaits SELECT SLEEP on the one-shot connection; the bounds are clamped', async () => {
	const m = await import('../cancel-probe.mjs');
	const sent = [];
	await m.cancelProbe(new URL('https://x.example/_cancel-probe?id=t3&kind=db&hold=request&ms=4000'), fakeCtx(), { log: () => {}, dbOneShot: async (sql) => { sent.push(sql); return { ok: true }; } });
	assert.deepEqual(sent, ['SELECT SLEEP(4)']);
	assert.equal(m.probeMs('999999'), 20000, 'at most 20 s');
	assert.equal(m.probeMs('x'), 5000, 'default 5 s');
	assert.equal(m.probeMs('10'), 1000, 'at least 1 s');
});
test('#1359 index.js: the route is checked after the spike-token gate, before the /_ 403, in serve()', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const serve = src.slice(src.indexOf('async serve(req, env, ctx) {'), src.indexOf('async serve(req, env, ctx) {') + 6000);
	const route = serve.indexOf('if (url.pathname === CANCEL_PROBE_PATH && cancelProbeAllowed(env, spikeOk))');
	assert.ok(route > 0, 'the route');
	assert.ok(route > serve.indexOf('const spikeOk ='), 'after the spike token is read');
	assert.ok(route < serve.indexOf("if (url.pathname.startsWith('/_') && !spikeOk)"), 'before the /_ 403 (a stranger still gets 403 or 404)');
});
