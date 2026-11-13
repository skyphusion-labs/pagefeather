import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { demoLocked, codeLocked, lockDefines } from '../site-lock.mjs';

const MODS = "define('DISALLOW_FILE_MODS', true);";
const EDIT = "define('DISALLOW_FILE_EDIT', true);";
const NOTICE = "define('SKYPHUSION_CODE_LOCK', true);";

test('the demo lock is on only for DEMO_LOCK=on', () => {
	assert.equal(demoLocked({ DEMO_LOCK: 'on' }), true);
	assert.equal(demoLocked({}), false);
	assert.equal(demoLocked({ DEMO_LOCK: 'off' }), false);
	assert.equal(demoLocked({ DEMO_LOCK: 'true' }), false);
	assert.equal(demoLocked(undefined), false);
});

test('the code lock is on for DEMO_LOCK=on or CODE_LOCK=on, and only those', () => {
	assert.equal(codeLocked({ DEMO_LOCK: 'on' }), true);
	assert.equal(codeLocked({ CODE_LOCK: 'on' }), true);
	assert.equal(codeLocked({}), false);
	assert.equal(codeLocked({ CODE_LOCK: 'off' }), false);
	assert.equal(codeLocked({ CODE_LOCK: 'true' }), false);
	assert.equal(codeLocked(undefined), false);
});

test('CODE_LOCK does not turn on the demo lock, so a one-click site keeps its mail', () => {
	assert.equal(demoLocked({ CODE_LOCK: 'on' }), false);
});

test('a demo site gets exactly the two defines it had before #406', () => {
	assert.deepEqual(lockDefines({ DEMO_LOCK: 'on' }), [MODS, EDIT]);
	assert.deepEqual(lockDefines({ DEMO_LOCK: 'on', CODE_LOCK: 'on' }), [MODS, EDIT]);
});

test('a one-click site gets the two defines and the notice constant', () => {
	assert.deepEqual(lockDefines({ CODE_LOCK: 'on' }), [MODS, EDIT, NOTICE]);
});

test('an unlocked site gets no extra defines', () => {
	assert.deepEqual(lockDefines({}), []);
	assert.deepEqual(lockDefines({ DEMO_LOCK: 'off', CODE_LOCK: 'off' }), []);
});

// index.js cannot be imported under node (it loads php-wasm), so these read its
// source: sendEmail must return before it touches the binding when the demo lock is
// on, and the wp-config builder must add the lock defines.
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('index.js sendEmail returns nothing when the demo lock is on, before any send', () => {
	const start = src.indexOf('function sendEmail(env, email) {');
	assert.ok(start >= 0, 'sendEmail not found');
	const body = src.slice(start, src.indexOf('\n}\n', start));
	const guard = body.indexOf('if (demoLocked(env)) return [];');
	assert.ok(guard >= 0, 'sendEmail has no demo lock guard');
	assert.ok(guard < body.indexOf('env.EMAIL'), 'the guard must come before the first use of env.EMAIL');
	assert.ok(!body.includes('codeLocked('), 'the code lock must not stop mail');
});

test('index.js adds the lock defines to the generated wp-config', () => {
	assert.ok(src.includes('lines.push(...lockDefines(ENV));'));
});

// The notice mu-plugin must be in the build, and it must be inert without the constant.
test('build.sh copies the code lock notice into mu-plugins', () => {
	const build = readFileSync(new URL('../build.sh', import.meta.url), 'utf8');
	assert.match(build, /cp [^\n]*php\/code-lock-notice\.php[^\n]*"\$wp\/wp-content\/mu-plugins\/"/);
});

test('the notice mu-plugin returns first unless SKYPHUSION_CODE_LOCK is true', () => {
	const php = readFileSync(new URL('../php/code-lock-notice.php', import.meta.url), 'utf8');
	const guard = php.indexOf("if ( ! defined( 'SKYPHUSION_CODE_LOCK' ) || true !== SKYPHUSION_CODE_LOCK ) {");
	assert.ok(guard >= 0, 'no constant guard');
	assert.ok(guard < php.indexOf('add_action('), 'the guard must come before add_action');
});
