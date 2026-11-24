// originless-decide.py: grey-cloud or wrong content is not ok.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const PY = join(DIR, 'originless-decide.py');

function decide(want, result) {
	const r = spawnSync('python3', [PY], {
		env: { ...process.env, WANT_CONTENT: want },
		input: JSON.stringify({ result }),
		encoding: 'utf8',
	});
	assert.equal(r.status, 0, r.stderr);
	return r.stdout.trim();
}

test('empty list -> create', () => {
	assert.equal(decide('192.0.2.1', []), 'create');
});

test('proxied + correct content -> ok', () => {
	assert.equal(
		decide('192.0.2.1', [{ id: 'a', proxied: true, content: '192.0.2.1' }]),
		'ok',
	);
});

test('grey-cloud correct content -> patch', () => {
	assert.equal(
		decide('192.0.2.1', [{ id: 'g', proxied: false, content: '192.0.2.1' }]),
		'patch g',
	);
});

test('proxied wrong content -> patch', () => {
	assert.equal(
		decide('192.0.2.1', [{ id: 'w', proxied: true, content: '203.0.113.1' }]),
		'patch w',
	);
});

test('AAAA 100:: proxied -> ok', () => {
	assert.equal(
		decide('100::', [{ id: '6', proxied: true, content: '100::' }]),
		'ok',
	);
});

test('multiple none good -> fail', () => {
	assert.equal(
		decide('192.0.2.1', [
			{ id: '1', proxied: false, content: '192.0.2.1' },
			{ id: '2', proxied: true, content: '203.0.113.9' },
		]),
		'fail 1,2',
	);
});
