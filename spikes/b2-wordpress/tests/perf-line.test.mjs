// node --test spikes/b2-wordpress/tests/perf-line.test.mjs (#1078)
// Approach A (PHP in the Worker, Hyperdrive) logged no per-request timing: the m: perf line was built only inside
// the object (ctx.inObject), so a tail could not time a real suite request on A. aPerfLine is the same line for A:
// wall, boot, PHP time, the query count and their total round trip (on A every MySQL query is one bridge call), the
// isolate and the runtime. Path only, never a query string (a store's URLs carry order keys and logins there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aPerfLine } from '../perf-line.mjs';

test('the A perf line carries the timing split and the query count and time', () => {
	const l = aPerfLine({ id: 'x1', method: 'GET', path: '/wp-admin/post.php', status: 200, iso: 'abc123', isoAgeS: 40, rt: 2, rtAgeS: 12, boot: false, bootWaitMs: 0, phpMs: 1800, dbN: 152, dbMs: 1420, wallMs: 1850, wasm1MiB: 92, recycled: null });
	assert.equal(l.m, 'perf');
	assert.equal(l.tier, 'a');
	assert.deepEqual(
		{ boot: l.boot, bootWaitMs: l.bootWaitMs, phpMs: l.phpMs, dbN: l.dbN, dbMs: l.dbMs, wallMs: l.wallMs, iso: l.iso, rt: l.rt, status: l.status },
		{ boot: 0, bootWaitMs: 0, phpMs: 1800, dbN: 152, dbMs: 1420, wallMs: 1850, iso: 'abc123', rt: 2, status: 200 },
	);
	assert.equal(l.dbAvgMs, 9.3, 'the per-query round trip, the multiplier #1078 needs');
});
test('a boot is 1, a recycle is named, and an unknown field is left out (never null noise)', () => {
	const l = aPerfLine({ path: '/', status: 200, boot: true, bootWaitMs: 2900, phpMs: 300, dbN: 0, dbMs: 0, wallMs: 3300, recycled: 'memory' });
	assert.equal(l.boot, 1);
	assert.equal(l.recycled, 'memory');
	assert.equal(l.dbAvgMs, undefined, 'no queries: no average');
	assert.ok(!('id' in l) && !('iso' in l), 'absent fields are omitted');
});
test('path only: a query string never reaches the log', () => {
	const l = aPerfLine({ path: '/checkout/order-received/12?key=wc_order_SECRET&login=alice', status: 200, dbN: 1, dbMs: 1 });
	assert.equal(l.path, '/checkout/order-received/12');
	assert.ok(!JSON.stringify(l).includes('SECRET'));
});
test('index.js: approach A (not in the object) logs aPerfLine with this request d.calls and d.ms', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{ aPerfLine \} from '\.\/perf-line\.mjs';/);
	assert.match(src, /\} else \{\n\t\t\t\t\/\/ #1078[^\n]*\n(?:\t\t\t\t\/\/[^\n]*\n)*\t\t\t\tconsole\.log\(JSON\.stringify\(aPerfLine\(\{[^\n]*dbN: d\.calls, dbMs: d\.ms/);
});

// #1078 round 2: strummer's cf759hl probe put 13 to 15 s of a list page in PHP, not MySQL. On Cloudflare Date.now()
// moves only at I/O, so phpMs cannot split compute from waiting. The A line also carries what PHP waited on besides
// MySQL (remote OPcache and site pack fetches, outbound HTTP), the inflates, and OPcache hits and misses (spike token
// plus x-perf-opcache: 1, as on b-dosql), so one tail names where the time goes.
test('#1078: the A line carries OPcache, remote pack fetches, outbound HTTP and inflates', () => {
	const l = aPerfLine({ path: '/wp-admin/edit.php', status: 200, dbN: 130, dbMs: 1700, phpMs: 13900, opHits: 2100, opMisses: 4, opCached: 2600, opFull: false, rfN: 41, rfKiB: 9100, rfMs: 11200, rfFail: 0, rsN: 3, rsKiB: 210, rsMs: 120, rsFail: 0, httpN: 1, httpMs: 300, inflates: 12, inflateKiB: 4000 });
	assert.deepEqual(
		[l.opHits, l.opMisses, l.opCached, l.opFull, l.rfN, l.rfKiB, l.rfMs, l.rfFail, l.rsN, l.rsKiB, l.rsMs, l.rsFail, l.httpN, l.httpMs, l.inflates, l.inflateKiB],
		[2100, 4, 2600, false, 41, 9100, 11200, 0, 3, 210, 120, 0, 1, 300, 12, 4000],
	);
});
test('#1078: index.js passes the per-request deltas, and OPcache counters are not object-only any more', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /const wantOpcache = spikeOk && req\.headers\.get\('x-perf-opcache'\) === '1';/);
	assert.match(src, /aPerfLine\(\{[^\n]*rfN: stats\.rfN - remote0\.rfN[^\n]*rsN: stats\.rsN - remote0\.rsN[^\n]*httpN: stats\.httpCalls - start\.httpCalls[^\n]*opHits: op1\.hits - op0\.hits - 1/);
});

// #1078 round 3: strummer's tail on cf759hl puts the slow list pages at 1.1 to 1.5 s CPU against 14 to 17 s wall, so
// 11 to 13 s is waiting, beyond MySQL's 2 s. On A every object-cache key that misses the isolate Map is an OC_KV.get,
// one after another (objectCacheOp), and nothing timed them. The line now carries the L2 reads: count, hits, misses, ms.
test('#1078: the A line carries the object cache bridge calls and the KV L2 reads (n, hits, misses, ms)', () => {
	const l = aPerfLine({ path: '/wp-admin/edit.php', status: 200, ocCalls: 300, ocHits: 120, l2N: 180, l2Hits: 3, l2Misses: 177, l2Ms: 11400 });
	assert.deepEqual([l.ocCalls, l.ocHits, l.l2N, l.l2Hits, l.l2Misses, l.l2Ms], [300, 120, 180, 3, 177, 11400]);
});
test('#1078: objectCacheOp counts and times every OC_KV.get, and the A line passes the deltas', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /const tl2 = Date\.now\(\);\n\t\t\t\ttry \{ kv = await ENV\.OC_KV\.get\(ocKvKey\(k\)\); \} catch \{ kv = null; \}\n\t\t\t\tstats\.l2N\+\+;\n\t\t\t\tstats\.l2Ms \+= Date\.now\(\) - tl2;/);
	assert.match(src, /aPerfLine\(\{[^\n]*ocCalls: stats\.ocCalls - start\.ocCalls[^\n]*l2N: stats\.l2N - start\.l2N[^\n]*l2Ms: stats\.l2Ms - start\.l2Ms/);
});

// #1119 (strummer's overflow check): the perf line's wallMs starts after the PHP lock wait, so a term GET that waited
// 13.5 s behind a product batch read 262 ms. The line now carries lockWaitMs: from arrival at the lock to its grant.
test('#1119 aPerfLine carries lockWaitMs', () => {
	assert.equal(aPerfLine({ path: '/', status: 200, lockWaitMs: 13540, wallMs: 262 }).lockWaitMs, 13540);
	assert.equal(aPerfLine({ path: '/', status: 200 }).lockWaitMs, undefined, 'absent stays absent');
});
test('#1119 index.js: the worker run measures its lock wait at the grant and the A perf line logs it', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /const lockT0 = Date\.now\(\);\n\t+const workerRun = await withPhp\(\(\) => withRunCall\(callId, \(\) => handle\(req, env, url, spikeOk, maxBody, ctx\), Date\.now\(\) - lockT0\)/);
	assert.match(src, /lockWaitMs: runLockWaitMs, /);
});

// #1153: php/php-fatal-line.php sends a PHP fatal (or a 500 wp_die) through the bridge; the Worker logs php-fatal.
test('#1153 index.js logs a PHP fatal as php-fatal, with its fields (bounded) and the call id', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const at = src.indexOf('if (m.phpFatal) {');
	assert.ok(at > 0);
	const line = src.slice(at, src.indexOf('\n', at));
	assert.match(line, /'@event': 'php-fatal', m: 'php-fatal', iso: ISOLATE_ID, \.\.\.\(runCallId \? \{ call: runCallId \} : \{\}\)/);
	for (const f of ['type: str(f.type, 10)', 'msg: str(f.msg, 300)', 'file: str(f.file, 160)', 'line: Number(f.line)', 'method: str(f.method, 10)', 'path: str(f.path, 160)']) assert.ok(line.includes(f), f);
	assert.match(line, /return '1'; \}$/);
});
