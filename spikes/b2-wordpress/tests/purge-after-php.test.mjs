// #935: a platform reset in the page-cache purge, after PHP has answered, returns
// that answer. It must not fall through to the bare internal error body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('a purge reset after PHP answers returns that answer, not internal error', () => {
	const call = src.indexOf('await ctx.requestPurge()');
	const internal = src.indexOf("return new Response('internal error'");
	assert.ok(call > 0, 'requestPurge is awaited');
	assert.ok(internal > call, 'the bare internal error catch is still after the purge');
	const before = src.slice(Math.max(0, call - 600), call);
	assert.match(before, /try \{/);
	assert.match(before, /let purgeReset = null/);
	const between = src.slice(call, internal);
	assert.match(between, /isResetKind\(kind\)/);
	const loss = between.indexOf('if (lost)');
	const reset = between.indexOf('if (purgeReset)');
	assert.ok(loss > 0 && reset > loss, 'a lost write is decided before the purge-reset return');
	const block = between.slice(reset, reset + 900);
	assert.match(block, /dropRuntime\(\)/);
	assert.match(block, /return new Response\(r\.bytes, \{ status: r\.httpStatusCode, headers: out \}\)/);
	assert.doesNotMatch(block, /internal error/);
});
