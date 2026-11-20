// #1032 (and #964/#967): the Turnstile submit hold. It must survive WordPress content filters (a block theme puts the
// comment form inside the texturized template HTML, where "&&" became "&#038;&#038;"), and it must hold submit until
// the token is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const php = readFileSync(new URL('../php/turnstile-forms.php', import.meta.url), 'utf8');
const start = php.indexOf("return <<<'JS'");
const hold = php.slice(start + "return <<<'JS'".length, php.indexOf('\nJS;', start));

test('the hold script has no "&" and no "<", so wptexturize and convert_chars cannot change it', () => {
	assert.ok(hold.includes('data-pf-held'), 'found the hold script');
	assert.equal((hold.match(/&/g) || []).length, 0);
	assert.equal((hold.match(/</g) || []).length, 0);
});

test('THE #1032 CASE: the hold as cf759a served it (&& as &#038;&#038;) does not parse; ours does', () => {
	const served = 'var ok = !!(field &#038;&#038; field.value);';
	assert.throws(() => new vm.Script(served), SyntaxError);
	assert.doesNotThrow(() => new vm.Script(hold));
	// What a texturize pass would do to ours: replace each bare & with &#038;. Nothing to replace.
	assert.equal(hold.replace(/&/g, '&#038;'), hold);
});

function page() {
	const field = { value: '' };
	const button = { disabled: false, attrs: {}, getAttribute(k) { return this.attrs[k] ?? null; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
	const form = {
		attrs: {},
		getAttribute(k) { return this.attrs[k] ?? null; },
		setAttribute(k, v) { this.attrs[k] = v; },
		querySelector: (sel) => (sel === '[name=cf-turnstile-response]' ? field : null),
		querySelectorAll: (sel) => (sel === 'button[type=submit], input[type=submit]' ? [button] : []),
	};
	const box = { closest: (sel) => (sel === 'form' ? form : null) };
	const timers = [];
	const ctx = {
		document: { readyState: 'complete', querySelectorAll: (sel) => (sel === '.cf-turnstile' ? [box] : []), addEventListener() {} },
		setInterval: (fn) => { timers.push(fn); return timers.length; },
		clearInterval: (id) => { timers[id - 1] = null; },
	};
	vm.runInNewContext(hold, ctx);
	const tick = (n = 1) => { for (let i = 0; i < n; i++) for (const t of timers) if (t) t(); };
	return { field, button, tick, timers };
}

test('submit is held while the token is empty, and released once it is set', () => {
	const p = page();
	p.tick();
	assert.equal(p.button.disabled, true, 'held on the first tick');
	p.tick(5);
	assert.equal(p.button.disabled, true, 'still held');
	p.field.value = 'XXXX.DUMMY.TOKEN';
	p.tick();
	assert.equal(p.button.disabled, false, 'released with a token');
	assert.equal(p.timers.every((t) => t === null), true, 'the timer stops');
});

test('with no token, submit is released after 150 ticks (15 s), so the server error can show', () => {
	const p = page();
	p.tick(150);
	assert.equal(p.button.disabled, true);
	p.tick();
	assert.equal(p.button.disabled, false);
});
