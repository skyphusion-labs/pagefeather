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

test('the code lock is on for every site (#458); only CODE_LOCK=off turns it off, never on a demo', () => {
	assert.equal(codeLocked({}), true, 'a site with no var is locked');
	assert.equal(codeLocked(undefined), true);
	assert.equal(codeLocked({ CODE_LOCK: 'on' }), true);
	assert.equal(codeLocked({ CODE_LOCK: 'true' }), true, 'any value other than off keeps the lock');
	assert.equal(codeLocked({ CODE_LOCK: 'OFF' }), true);
	assert.equal(codeLocked({ CODE_LOCK: 'off' }), false, 'off is the only way out (a local or throwaway test)');
	assert.equal(codeLocked({ DEMO_LOCK: 'on' }), true);
	assert.equal(codeLocked({ DEMO_LOCK: 'on', CODE_LOCK: 'off' }), true, 'a demo site is always locked');
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

test('the default is locked: only CODE_LOCK=off renders no lock defines (#458)', () => {
	assert.deepEqual(lockDefines({}), [MODS, EDIT, NOTICE], 'a site with no var renders the lock constants (#458)');
	assert.deepEqual(lockDefines({ DEMO_LOCK: 'off', CODE_LOCK: 'off' }), [], 'only an explicit CODE_LOCK=off renders nothing');
	assert.deepEqual(lockDefines({ DEMO_LOCK: 'on', CODE_LOCK: 'off' }), [MODS, EDIT], 'a demo keeps its lock');
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

// The Hyperdrive store (#431) runs index-a-lean.js. It must reuse index.js's worker
// (and so its boot and wp-config builder, with the lock defines, ungated by kind),
// never a builder of its own.
test('approach A (index-a-lean.js) boots through index.js, so its wp-config gets the lock defines', () => {
	const lean = readFileSync(new URL('../index-a-lean.js', import.meta.url), 'utf8');
	assert.match(lean, /^import worker, \{[^}]*\} from '\.\/index\.js';$/m, 'index-a-lean.js does not take its worker from index.js');
	assert.match(lean, /^export default worker;$/m, 'index-a-lean.js does not export index.js worker');
	assert.ok(!/wp-config|lockDefines|define\(/.test(lean), 'index-a-lean.js writes wp-config itself');
	const boot = src.slice(src.indexOf('async function boot(origin) {'));
	const at = boot.indexOf('lines.push(...lockDefines(ENV));');
	assert.ok(at > 0, 'boot does not add the lock defines');
	const before = boot.slice(0, at).split('\n').slice(-3).join('\n');
	assert.ok(!/^\s*if \(/m.test(before.split('\n').pop()), 'the lock defines line is gated');
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
