// cron-bound.mjs (issue #291): a bounded cron tick on a big store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cronBounds, cronCleanDue, CLEAN_MS, DEFAULT_ACTIONS, DEFAULT_WP_EVENTS } from '../cron-bound.mjs';

test('defaults when unset or bad', () => {
	assert.deepEqual(cronBounds({}), { actions: DEFAULT_ACTIONS, wpEvents: DEFAULT_WP_EVENTS });
	assert.deepEqual(cronBounds(undefined), { actions: DEFAULT_ACTIONS, wpEvents: DEFAULT_WP_EVENTS });
	assert.deepEqual(cronBounds({ CRON_AS_ACTIONS: 'x', CRON_WP_EVENTS: '-3' }), { actions: DEFAULT_ACTIONS, wpEvents: DEFAULT_WP_EVENTS });
	assert.deepEqual(cronBounds({ CRON_AS_ACTIONS: '0', CRON_WP_EVENTS: '51' }), { actions: DEFAULT_ACTIONS, wpEvents: DEFAULT_WP_EVENTS });
});
test('values in range are taken; WP-Cron 0 is allowed (skip)', () => {
	assert.deepEqual(cronBounds({ CRON_AS_ACTIONS: '7', CRON_WP_EVENTS: '0' }), { actions: 7, wpEvents: 0 });
});
test('the bound is interpolated as an integer only (no injection into the PHP)', () => {
	const b = cronBounds({ CRON_AS_ACTIONS: '3; system("x")', CRON_WP_EVENTS: '2' });
	assert.equal(b.actions, 3); assert.ok(Number.isInteger(b.actions) && Number.isInteger(b.wpEvents));
});

const now = Date.parse('2026-11-12T07:00:00Z');
test('cleaner: never cleaned -> due', () => {
	assert.equal(cronCleanDue(undefined, now), true);
	assert.equal(cronCleanDue(0, now), true);
});
test('cleaner: within the interval -> not due; at or past it -> due', () => {
	assert.equal(cronCleanDue(now - CLEAN_MS + 1, now), false);
	assert.equal(cronCleanDue(now - CLEAN_MS, now), true);
});
test('THE LEAD CASE: a 900-action backlog at one action a minute never idles, yet the cleaner runs every 10 min', () => {
	let last, cleans = 0;
	for (let m = 0; m < 180; m++) { // 3 h of busy ticks, none idle
		const t = now + m * 60000;
		if (cronCleanDue(last, t)) { cleans++; last = t; }
	}
	assert.equal(cleans, 18);
});
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
test('index.js: the cron uses its own claim loop, not the queue runner', () => {
	const r = src.slice(src.indexOf('async function runCron('));
	const body = r.slice(0, r.indexOf('async function toPhpObject'));
	assert.equal(body.includes("do_action( 'action_scheduler_run_queue'"), false);
	assert.ok(body.includes('stake_claim( ${actions} )') && body.includes('process_action(') && body.includes('release_claim('));
	assert.ok(/process_action\([^;]*;[^;]*;\s*\n[\s\S]{0,400}wp_cache_flush_runtime\(\)/.test(body), 'flush after each action');
	assert.ok(body.includes('0 === $as_n || ${cleanDue ? 1 : 0}'), 'cleaner on idle OR when due');
});
test('index.js: the alarm passes cleanDue and stores the clean time', () => {
	assert.ok(src.includes('cronCleanDue(await this.ctx.storage.get(CRON_CLEAN_KEY), Date.now())'));
	assert.ok(src.includes('if (cr && cr.cleaned) await this.ctx.storage.put(CRON_CLEAN_KEY, Date.now());'));
});
