// node --test spikes/b2-wordpress/tests/db-lifecycle.test.mjs (#1087)
// cf759hx (approach A, A_CRON=1): the cron object's alarm legs held about 59 s each, stalled after an order, then every
// leg threw 16x "Cannot perform I/O on behalf of a different Durable Object ... (I/O type: Writable)". The MySQL
// connection (mysql-bridge.js) is ONE module-level socket per isolate. The Worker fetch path reset it at fetch start
// and ended it after its run, but the cron leg (runCron, in alarm()) did neither, so a leg reused the socket an earlier
// leg, another context, had opened; and a fetch-start reset (outside the PHP lock) could null a running run's socket.
// The fix: a connection lives exactly one PHP run. withDbRun resets it after the lock is taken and ends it (awaited)
// before the lock is released; PHP runs are serialized per isolate, so no two contexts ever share a socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withDbRun } from '../db-lifecycle.mjs';

// A fake mysql-bridge with workerd's rule: a socket belongs to the I/O context that opened it.
function fakeBridge() {
	let conn = null;
	const log = { opened: 0, ended: 0 };
	return {
		log,
		query(ctx) {
			if (!conn) { conn = { owner: ctx, open: true }; log.opened++; }
			if (conn.owner !== ctx) throw new Error('Cannot perform I/O on behalf of a different Durable Object (I/O type: Writable)');
			return 'ok';
		},
		reset() { conn = null; },
		async end() { const c = conn; conn = null; if (c) { c.open = false; log.ended++; } },
		get held() { return conn; },
	};
}

test('RED (the cf759hx bug): two alarm legs with no per-run lifecycle share one socket, and the second throws', () => {
	const b = fakeBridge();
	b.query('alarm-leg-1');
	assert.throws(() => b.query('alarm-leg-2'), /different Durable Object/);
});
test('withDbRun: each leg opens its own socket and ends it before the next run; no cross-context error', async () => {
	const b = fakeBridge();
	for (const leg of ['alarm-leg-1', 'alarm-leg-2', 'worker-fetch', 'alarm-leg-3']) {
		await withDbRun(b, async () => { b.query(leg); b.query(leg); });
		assert.equal(b.held, null, 'nothing is left open after ' + leg + ' (an open socket kept each 59 s leg alive)');
	}
	assert.equal(b.log.opened, 4);
	assert.equal(b.log.ended, 4);
});
test('withDbRun: a stale socket left by an earlier context is dropped at run start, not reused', async () => {
	const b = fakeBridge();
	b.query('dead-context'); // left open (the old runCron path)
	await withDbRun(b, async () => { assert.equal(b.query('alarm-leg'), 'ok'); });
});
test('withDbRun: the socket is ended even when the run throws', async () => {
	const b = fakeBridge();
	await assert.rejects(withDbRun(b, async () => { b.query('leg'); throw new Error('php fatal'); }), /php fatal/);
	assert.equal(b.held, null);
	assert.equal(b.log.ended, 1);
});
test('withDbRun: no database handler (b-dosql) runs fn unchanged', async () => {
	assert.equal(await withDbRun(null, async () => 7), 7);
});
test('index.js: every locked PHP run goes through withDbRun; no reset outside the lock; the operator DB endpoints run under the lock', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{ withDbRun \} from '\.\/db-lifecycle\.mjs';/);
	assert.match(src, /retirer\.runStart\(\);\n\t\t\ttry \{\n\t\t\t\treturn await withDbRun\(dbHandler, fn\);/);
	assert.equal((src.match(/dbHandler\.reset\(\)/g) || []).length, 0, 'the reset lives in withDbRun only');
	assert.match(src, /return dbHandler \? withPhp\(\(\) => d1pingRun\(req, env, url, ctx\)\) : d1pingRun\(req, env, url, ctx\);/);
	assert.match(src, /const out = await withPhp\(\(\) => cacheVersions\[op\]\(q, tablePrefix\(env\)\)\);/);
	assert.match(src, /const out = await withPhp\(\(\) => pageVersions\[op\]\(q, tablePrefix\(env\)\)\);/);
});
