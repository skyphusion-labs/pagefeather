// node --test spikes/b2-wordpress/tests/perf-line.test.mjs (#1078)
// Approach A (PHP in the Worker, Hyperdrive) logged no per-request timing: the m: perf line was built only inside
// the object (ctx.inObject), so a tail could not time a real suite request on A. aPerfLine is the same line for A:
// wall, boot, PHP time, the query count and their total round trip (on A every MySQL query is one bridge call), the
// isolate and the runtime. Path only, never a query string (a store's URLs carry order keys and logins there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aPerfLine } from '../perf-line.mjs';

test('the A perf line carries the timing split and the query count and time', () => {
	const l = aPerfLine({ id: 'x1', method: 'GET', path: '/wp-admin/post.php', status: 200, iso: 'abc123', isoAgeS: 40, rt: 2, rtAgeS: 12, boot: false, bootWaitMs: 0, phpMs: 1800, dbN: 152, dbMs: 1420, wallMs: 1850, wasm1MiB: 92, recycled: null });
	assert.equal(l.m, 'perf');
	assert.equal(l.tier, 'a');
	assert.deepEqual(
		{ boot: l.boot, bootWaitMs: l.bootWaitMs, phpMs: l.phpMs, dbN: l.dbN, dbMs: l.dbMs, wallMs: l.wallMs, iso: l.iso, rt: l.rt, status: l.status },
		{ boot: 0, bootWaitMs: 0, phpMs: 1800, dbN: 152, dbMs: 1420, wallMs: 1850, iso: 'abc123', rt: 2, status: 200 },
	);
	assert.equal(l.dbAvgMs, 9.3, 'the per-query round trip, the multiplier #1078 needs');
});
test('a boot is 1, a recycle is named, and an unknown field is left out (never null noise)', () => {
	const l = aPerfLine({ path: '/', status: 200, boot: true, bootWaitMs: 2900, phpMs: 300, dbN: 0, dbMs: 0, wallMs: 3300, recycled: 'memory' });
	assert.equal(l.boot, 1);
	assert.equal(l.recycled, 'memory');
	assert.equal(l.dbAvgMs, undefined, 'no queries: no average');
	assert.ok(!('id' in l) && !('iso' in l), 'absent fields are omitted');
});
test('path only: a query string never reaches the log', () => {
	const l = aPerfLine({ path: '/checkout/order-received/12?key=wc_order_SECRET&login=alice', status: 200, dbN: 1, dbMs: 1 });
	assert.equal(l.path, '/checkout/order-received/12');
	assert.ok(!JSON.stringify(l).includes('SECRET'));
});
test('index.js: approach A (not in the object) logs aPerfLine with this request d.calls and d.ms', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{ aPerfLine \} from '\.\/perf-line\.mjs';/);
	assert.match(src, /\} else \{\n\t\t\t\t\/\/ #1078[^\n]*\n(?:\t\t\t\t\/\/[^\n]*\n)*\t\t\t\tconsole\.log\(JSON\.stringify\(aPerfLine\(\{[^\n]*dbN: d\.calls, dbMs: d\.ms/);
});
