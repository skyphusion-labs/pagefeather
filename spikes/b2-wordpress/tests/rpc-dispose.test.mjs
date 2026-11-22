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
	// The Worker path (#837: schedulePurge hands the result to a-purge.mjs): copy ok, errors and error, then dispose;
	// index.js passes disposeRpc as the purger's dispose.
	const ap = readFileSync(new URL('../a-purge.mjs', import.meta.url), 'utf8');
	const w = ap.indexOf('r = await ctx.purge();');
	assert.ok(w > 0, 'a-purge.mjs sends the purge');
	const wBlock = ap.slice(w, w + 600);
	const wCopied = wBlock.indexOf('const error = (r && r.error) || null;');
	const wDisp = wBlock.indexOf('dispose(r);');
	assert.ok(wCopied > 0 && wBlock.indexOf('const ok = !!(r && r.ok);') > 0 && wBlock.indexOf('const errors = (r && r.errors) || [];') > 0, 'the gateway copies ok, errors and error');
	assert.ok(wDisp > wCopied, 'the gateway copies r, then disposes it');
	assert.ok(!/onResult\([^)]*\br\b/.test(wBlock.slice(wDisp)), 'onResult never gets r after the dispose');
	assert.match(src, /createGatewayPurger\(\{ env: ENV, dispose: disposeRpc \}\)/, 'index.js gives the purger disposeRpc');
	// The PHP object's alarm path: copy every field it reads (ok, errors, error), then dispose (#699: purge-state.mjs
	// gets the copies, never r).
	const o = src.indexOf("r = await this.ctx.exports.Pages.purge(['wp-pages']);");
	assert.ok(o > 0);
	const oBlock = src.slice(o, o + 800);
	const oCopied = oBlock.indexOf('const error = (r && r.error) || null;');
	const oDisp = oBlock.indexOf('disposeRpc(r);');
	assert.ok(oCopied > 0 && oBlock.indexOf('const ok = !!(r && r.ok);') > 0 && oBlock.indexOf('const errors = (r && r.errors) || [];') > 0, 'the alarm copies ok, errors and error');
	assert.ok(oDisp > oCopied, 'the alarm copies r, then disposes it');
	assert.ok(!/\br\b(?!\.)[^;]*onResult|onResult\([^)]*\br\b/.test(oBlock.slice(oDisp)), 'onResult never gets r after the dispose');
	// No purge result is left undisposed: index.js has two purge calls (the gateway's, handed to a-purge.mjs, and the
	// alarm's) and disposes the alarm's itself; a-purge.mjs disposes the gateway's (#837).
	assert.equal((src.match(/exports\.Pages\.purge\(/g) || []).length, 2);
	assert.equal((src.match(/disposeRpc\(r\);/g) || []).length, 1);
	assert.equal((ap.match(/dispose\(r\);/g) || []).length, 1);
});
