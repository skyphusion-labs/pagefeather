import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { demoLocked, demoLockDefines } from '../site-lock.mjs';

test('the lock is on only for DEMO_LOCK=on', () => {
	assert.equal(demoLocked({ DEMO_LOCK: 'on' }), true);
	assert.equal(demoLocked({}), false);
	assert.equal(demoLocked({ DEMO_LOCK: 'off' }), false);
	assert.equal(demoLocked({ DEMO_LOCK: 'true' }), false);
	assert.equal(demoLocked(undefined), false);
});

test('a locked site gets the file-mods and file-edit defines', () => {
	const lines = demoLockDefines({ DEMO_LOCK: 'on' });
	assert.ok(lines.includes("define('DISALLOW_FILE_MODS', true);"));
	assert.ok(lines.includes("define('DISALLOW_FILE_EDIT', true);"));
});

test('an unlocked site gets no extra defines', () => {
	assert.deepEqual(demoLockDefines({}), []);
	assert.deepEqual(demoLockDefines({ DEMO_LOCK: 'off' }), []);
});

// index.js cannot be imported under node (it loads php-wasm), so these read its
// source: sendEmail must return before it touches the binding when the lock is on,
// and the wp-config builder must add the lock defines.
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('index.js sendEmail returns nothing when the lock is on, before any send', () => {
	const start = src.indexOf('function sendEmail(env, email) {');
	assert.ok(start >= 0, 'sendEmail not found');
	const body = src.slice(start, src.indexOf('\n}\n', start));
	const guard = body.indexOf('if (demoLocked(env)) return [];');
	assert.ok(guard >= 0, 'sendEmail has no demo lock guard');
	assert.ok(guard < body.indexOf('env.EMAIL'), 'the guard must come before the first use of env.EMAIL');
});

test('index.js adds the lock defines to the generated wp-config', () => {
	assert.ok(src.includes('lines.push(...demoLockDefines(ENV));'));
});
