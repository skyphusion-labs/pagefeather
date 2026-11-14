// node --test spikes/b2-wordpress/tests/rpc-dispose.test.mjs (#510)
// Every Pages.purge RPC result is disposed once its fields are read. disposeRpc() is taken from the
// shipped source and run as is (index.js cannot be imported under node: it loads php-wasm).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const at = src.indexOf('function disposeRpc(r) {');
assert.ok(at >= 0, 'disposeRpc is in index.js');
const body = src.slice(at, src.indexOf('\n}\n', at) + 2);
const disposeRpc = new Function(body + '\nreturn disposeRpc;')();

test('disposeRpc calls the result\'s disposer once, and tolerates none or a throwing one', () => {
	let n = 0;
	disposeRpc({ ok: true, [Symbol.dispose]() { n++; } });
	assert.equal(n, 1);
	assert.doesNotThrow(() => disposeRpc({ ok: true }));
	assert.doesNotThrow(() => disposeRpc(null));
	assert.doesNotThrow(() => disposeRpc({ [Symbol.dispose]() { throw new Error('boom'); } }));
});

test('both purge call sites dispose the result AFTER reading its fields', () => {
	// The Worker path (schedulePurge): log the fields, then dispose.
	const w = src.indexOf(".then(() => ctx.exports.Pages.purge(['wp-pages']))");
	assert.ok(w > 0);
	const wBlock = src.slice(w, src.indexOf('.catch(', w));
	const wLog = wBlock.indexOf("m: 'purge', sent: 1, ok: !!(r && r.ok)");
	const wDisp = wBlock.indexOf('disposeRpc(r);');
	assert.ok(wLog > 0 && wDisp > wLog, 'schedulePurge reads r, then disposes it');
	// The PHP object's alarm path: copy the fields into sent, then dispose.
	const o = src.indexOf("r = await this.ctx.exports.Pages.purge(['wp-pages']);");
	assert.ok(o > 0);
	const oBlock = src.slice(o, o + 800);
	const oSent = oBlock.indexOf('const sent = { t: st.lastSent, ok, errors: (r && r.errors) || [], error: (r && r.error) || null };');
	const oDisp = oBlock.indexOf('disposeRpc(r);');
	assert.ok(oSent > 0 && oDisp > oSent, 'the alarm copies r into sent, then disposes it');
	// No purge result is left undisposed: as many disposeRpc(r) calls as purge calls.
	assert.equal((src.match(/exports\.Pages\.purge\(/g) || []).length, 2);
	assert.equal((src.match(/disposeRpc\(r\);/g) || []).length, 2);
});
