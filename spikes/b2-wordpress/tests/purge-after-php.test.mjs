// #1007 (and #935/#944): the page-cache purge after PHP has answered. The answer is always returned; a purge
// that throws is logged and asked once more off the response path, never swallowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { askPurgeAfterAnswer } from '../purge-after-php.mjs';

const memoryMsg = 'Durable Object exceeded its memory limit and was reset.';

function stubCtx(answers) {
	const calls = [];
	const waited = [];
	return {
		calls,
		waited,
		ctx: {
			requestPurge: async () => {
				calls.push(1);
				const a = answers[calls.length - 1];
				if (a instanceof Error) throw a;
				return a;
			},
			waitUntil: (p) => waited.push(p),
		},
	};
}

test('a purge that works: its header, no retry, no log', async () => {
	const s = stubCtx(['scheduled']);
	const logs = [];
	const r = await askPurgeAfterAnswer(s.ctx, '/x', (o) => logs.push(o));
	assert.deepEqual(r, { header: 'scheduled', resetKind: null, retry: null });
	assert.equal(s.calls.length, 1);
	assert.equal(logs.length, 0);
});

test('THE #1007 CASE: a purge that throws is retried once off the response path, and the retry is logged', async () => {
	const s = stubCtx([new Error('storage get failed'), 'scheduled']);
	const logs = [];
	const r = await askPurgeAfterAnswer(s.ctx, '/wp-json/wp/v2/posts/7', (o) => logs.push(o));
	assert.equal(r.header, null);
	assert.equal(r.resetKind, null);
	assert.equal(typeof r.retry, 'function');
	assert.equal(logs[0].m, 'purge');
	assert.equal(logs[0].failed, 'storage get failed');
	assert.equal(s.calls.length, 1, 'no retry before the caller asks for it');
	const p = r.retry();
	assert.equal(s.waited.length, 1, 'the retry is handed to ctx.waitUntil');
	await p;
	assert.equal(s.calls.length, 2);
	assert.deepEqual(logs[1], { m: 'purge-retry', ok: true, header: 'scheduled', path: '/wp-json/wp/v2/posts/7' });
});

test('a reset kind is handed back, so the caller drops the runtime before the retry', async () => {
	const s = stubCtx([new Error(memoryMsg), 'coalesced']);
	const logs = [];
	const r = await askPurgeAfterAnswer(s.ctx, '/x', (o) => logs.push(o));
	assert.equal(r.resetKind, 'memory');
	await r.retry();
	assert.equal(logs[1].ok, true);
});

test('a retry that throws again is logged, never thrown', async () => {
	const s = stubCtx([new Error('one'), new Error('two')]);
	const logs = [];
	const r = await askPurgeAfterAnswer(s.ctx, '/x', (o) => logs.push(o));
	await r.retry();
	assert.equal(logs[1].m, 'purge-retry');
	assert.equal(logs[1].ok, false);
	assert.equal(logs[1].failed, 'two');
});

test('index.js wiring: the module is used, and every return after a failed ask calls the retry', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /await askPurgeAfterAnswer\(ctx, url\.pathname\)/);
	assert.doesNotMatch(src, /out\.set\('x-cache-purge', await ctx\.requestPurge\(\)\)/, 'no second, swallowing path');
	const ask = src.indexOf('await askPurgeAfterAnswer(ctx, url.pathname)');
	const after = src.slice(ask, src.indexOf("return new Response('internal error'", ask));
	// the lost write, the saved platform statement failure, the reset return, and the normal answer
	assert.ok((after.match(/if \(purgeRetry(?: && saved)?\) purgeRetry\(\)/g) || []).length >= 4, 'four retry calls');
	const reset = after.indexOf('if (purgeReset)');
	const block = after.slice(reset, reset + 400);
	assert.ok(block.indexOf('dropRuntime()') < block.indexOf('purgeRetry()'), 'the runtime is dropped before the retry');
	assert.doesNotMatch(block, /internal error/);
});
