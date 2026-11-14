// move-hold.mjs (#479): the move freeze's cron half.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moveHoldAsk, moveHoldRequest, MOVE_HOLD_KEY, MOVE_HOLD_MAX_MS } from '../move-hold.mjs';
import { cronHeld } from '../import-hold.mjs';

const now = Date.parse('2026-11-14T08:30:00Z');
const u = (q) => new URL('https://site/_hold' + q);
function store() {
	const m = new Map();
	return { m, get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); } };
}

test('a hold is set for the asked time, read back, and ends by itself', async () => {
	const s = store();
	const r = await (await moveHoldRequest(s, 'POST', u('?ms=600000'), now)).json();
	assert.deepEqual(r, { ok: true, held: true, until: now + 600000 });
	assert.equal(cronHeld(s.m.get(MOVE_HOLD_KEY), now + 599999), true);
	assert.equal(cronHeld(s.m.get(MOVE_HOLD_KEY), now + 600000), false, 'it ends at its time');
	const g = await (await moveHoldRequest(s, 'GET', u(''), now + 1000)).json();
	assert.equal(g.held, true);
});

test('off=1 ends the hold at once', async () => {
	const s = store();
	await moveHoldRequest(s, 'POST', u('?ms=600000'), now);
	const r = await (await moveHoldRequest(s, 'POST', u('?off=1'), now)).json();
	assert.deepEqual(r, { ok: true, held: false, until: null });
	assert.equal(s.m.has(MOVE_HOLD_KEY), false);
});

test('refusals change nothing: too short, too long, not a number, another method', async () => {
	const s = store();
	for (const [m, q, code] of [['POST', '?ms=59999', 400], ['POST', `?ms=${MOVE_HOLD_MAX_MS + 1}`, 400], ['POST', '?ms=1e6', 400], ['POST', '?ms=-60000', 400], ['POST', '', 400], ['PUT', '?ms=600000', 405]]) {
		const res = await moveHoldRequest(s, m, u(q), now);
		assert.equal(res.status, code, `${m} ${q}`);
	}
	assert.equal(s.m.size, 0);
	assert.deepEqual(moveHoldAsk('POST', u(`?ms=${MOVE_HOLD_MAX_MS}`), now), { until: now + MOVE_HOLD_MAX_MS }, 'the 2 h maximum is allowed');
});

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
test('index.js: /_hold sits behind the spike-token gate in the object, and the alarm checks the hold before the cron', () => {
	const route = src.indexOf("if (url.pathname === '/_hold') return moveHoldRequest(this.ctx.storage, req.method, url);");
	const gate = src.lastIndexOf("if (url.pathname.startsWith('/_') && !spikeOk) return new Response('forbidden', { status: 403 });", route);
	assert.ok(route > 0 && gate > 0 && gate < route, 'the route exists after the gate');
	const a = src.indexOf('async alarm() {');
	const held = src.indexOf('const moveHeld = cronHeld(await this.ctx.storage.get(MOVE_HOLD_KEY), Date.now());', a);
	const gateCron = src.indexOf('const cronGo = legDue && !bo.waitMs && !importHeld && !moveHeld && phpPending === 0', a);
	const run = src.indexOf('runCron(', a);
	assert.ok(held > a && gateCron > held && run > gateCron, 'the hold is read, then gates the cron leg, before runCron');
});
