// Tests of object-error.mjs (issue #335): an isolate memory reset is not a full queue.
// The messages are the platform's own, from Workers Logs on fdprobe1112g (2026-11-12) and
// docs/perf-dosql.md (2026-11-05).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyObjectError, objectErrorHeaders } from '../object-error.mjs';

const reset = Object.assign(new Error("Durable Object's isolate exceeded its memory limit and was reset."), { overloaded: true });
const queue = Object.assign(new Error('Durable Object is overloaded. Too many requests queued.'), { overloaded: true });

test('a memory reset is memory, also with e.overloaded set (as the platform sends it)', () => {
	assert.equal(classifyObjectError(reset), 'memory');
});

test('a full queue is overloaded, by the flag or by the message', () => {
	assert.equal(classifyObjectError(queue), 'overloaded');
	assert.equal(classifyObjectError(new Error('Durable Object is overloaded.')), 'overloaded');
	assert.equal(classifyObjectError({ overloaded: true, message: 'x' }), 'overloaded');
});

test('anything else is not classified (the caller throws it as before)', () => {
	assert.equal(classifyObjectError(new Error('Network connection lost.')), null);
	assert.equal(classifyObjectError(undefined), null);
});

test('the headers name the kind: x-isolate-reset for memory, x-overloaded for a queue, never both', () => {
	const m = objectErrorHeaders('memory', 'php-0', '5');
	assert.equal(m['x-isolate-reset'], 'memory');
	assert.equal(m['x-overloaded'], undefined);
	const o = objectErrorHeaders('overloaded', 'php-0', '5');
	assert.equal(o['x-overloaded'], '1');
	assert.equal(o['x-isolate-reset'], undefined);
	for (const h of [m, o]) {
		assert.equal(h['cache-control'], 'no-store');
		assert.equal(h['retry-after'], '5');
	}
});

test('index.js answers through the classifier, and never tags a memory reset x-overloaded', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{ classifyObjectError, objectErrorHeaders \} from '\.\/object-error\.mjs';/);
	const i = src.indexOf('async function toPhpObject(');
	const body = src.slice(i, src.indexOf('\n}\n', i));
	assert.match(body, /const kind = classifyObjectError\(e\);/);
	assert.match(body, /if \(!kind\) throw e;/);
	assert.doesNotMatch(body, /'x-overloaded': '1'/, 'the literal tag moved into objectErrorHeaders');
});
