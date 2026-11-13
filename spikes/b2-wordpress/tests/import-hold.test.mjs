// import-hold.mjs: a database import holds the cron off (2026-11-12, fdprobe1112a).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cronHeld, IMPORT_HOLD_KEY, IMPORT_HOLD_MS } from '../import-hold.mjs';

const now = Date.parse('2026-11-12T03:55:52Z');
test('no hold stored: the cron runs', () => {
	assert.equal(cronHeld(undefined, now), false);
	assert.equal(cronHeld(null, now), false);
});
test('THE FDPROBE1112A CASE: a part landed 27 s ago, so the cron is held', () => {
	assert.equal(cronHeld(Date.parse('2026-11-12T03:55:25Z') + IMPORT_HOLD_MS, now), true);
});
test('the hold ends by itself after the last part', () => {
	assert.equal(cronHeld(now - 1, now), false);
});
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
test('/_dbimport stores the hold BEFORE it imports', () => {
	const h = src.indexOf("url.pathname === '/_dbimport'");
	assert.ok(h >= 0);
	const put = src.indexOf('this.ctx.storage.put(IMPORT_HOLD_KEY, Date.now() + IMPORT_HOLD_MS)', h);
	const imp = src.indexOf('importInto(sql', h);
	assert.ok(put > h && imp > put, 'the hold is stored before importInto');
});
test('the alarm checks the hold before it runs the cron', () => {
	const a = src.indexOf('async alarm() {');
	const held = src.indexOf('cronHeld(await this.ctx.storage.get(IMPORT_HOLD_KEY)', a);
	const gate = src.indexOf('const cronGo = legDue && !importHeld && phpPending === 0', a); // #470 added legDue
	const cron = src.indexOf('runCron(', a);
	assert.ok(a >= 0 && held > a && gate > held && cron > gate);
});
test('the key is a fixed name', () => assert.equal(IMPORT_HOLD_KEY, 'import-hold-until'));
