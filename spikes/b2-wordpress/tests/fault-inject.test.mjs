// node --test spikes/b2-wordpress/tests/fault-inject.test.mjs (#730, #589 B): the operator-only post-INSERT
// fault injector. Armed only by the site var AND the spike token AND the request header; it fires after the
// request's INSERT into wp_posts that changed a row; the kill is a memory exhaustion (the platform's own reset
// path), and an isolate still alive after the cap is reported, never silent. Plus the index.js wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { faultArmed, isFaultTarget, exhaustMemory, FAULT_HEADER, FAULT_AFTER_INSERT, sqlFailNeedle, FAULT_SQL_FAIL, FAULT_SQL_HEADER, SQL_FAIL_MESSAGE, sqlFailMessage, FAULT_SQL_KIND_HEADER, SQL_FAIL_BUSY_MESSAGE, SQL_FAIL_OTHER_MESSAGE } from '../fault-inject.mjs';
import { MEMORY_RESET } from '../object-error.mjs';

const H = (o) => new Headers(o);
test('armed only with the var, the spike token and the header, all three', () => {
	const on = { FAULT_INJECT: 'after-insert' };
	const hdr = H({ [FAULT_HEADER]: FAULT_AFTER_INSERT });
	assert.equal(faultArmed(on, true, hdr), true);
	assert.equal(faultArmed({}, true, hdr), false, 'no var');
	assert.equal(faultArmed({ FAULT_INJECT: 'on' }, true, hdr), false, 'another value');
	assert.equal(faultArmed(on, false, hdr), false, 'no spike token');
	assert.equal(faultArmed(on, true, H({})), false, 'no header');
	assert.equal(faultArmed(on, true, H({ [FAULT_HEADER]: 'yes' })), false, 'another header value');
	assert.equal(faultArmed(on, 'true', hdr), false, 'spikeOk must be the boolean true');
});
test('the target is an INSERT into wp_posts that changed a row, nothing else', () => {
	for (const q of ['INSERT INTO wp_posts (post_title) VALUES (?)', 'insert into `wp_posts` (a) values (1)', ' INSERT INTO "wp_posts" ("a") VALUES (1)']) {
		assert.equal(isFaultTarget(q, { ok: true, changes: 1 }), true, q);
	}
	assert.equal(isFaultTarget('INSERT INTO wp_posts (a) VALUES (1)', { ok: true, changes: 0 }), false, 'changed nothing');
	assert.equal(isFaultTarget('INSERT INTO wp_posts (a) VALUES (1)', { ok: false }), false, 'failed');
	for (const q of ['INSERT INTO wp_postmeta (a) VALUES (1)', 'UPDATE wp_posts SET a = 1', 'DELETE FROM wp_posts', 'INSERT INTO wp_posts_x (a) VALUES (1)', 'SELECT * FROM wp_posts']) {
		assert.equal(isFaultTarget(q, { ok: true, changes: 1 }), false, q);
	}
});
test('the kill allocates and touches memory and holds it; alive after the cap is reported, not silent', () => {
	const held = [];
	let calls = 0;
	const alloc = () => { calls++; if (calls > 5 && calls % 2) throw new RangeError('Array buffer allocation failed'); return new ArrayBuffer(16); };
	const r = exhaustMemory({ alloc, held, capMiB: 12, chunkMiB: 1 });
	assert.equal(r.killed, false, 'a test process is not killed');
	assert.equal(r.mib, 12, 'it went to the cap, past the throws');
	assert.ok(r.throws > 0, 'a RangeError is counted, never ends the loop early');
	assert.equal(held.length, 12, 'every chunk is held, so nothing can be collected');
	assert.ok(new Uint8Array(held[0])[0] === 1, 'each chunk is touched (filled), so it is committed');
});
test('index.js wiring: armed per object request, fired after the statement, one shot, logged', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{[^}]*faultArmed[^}]*\} from '\.\/fault-inject\.mjs'/);
	assert.match(src, /faultPending = faultArmed\(env, spikeOk, req\.headers\)/, 'armed in the object fetch, from the spike check');
	const sqlStmt = src.slice(src.indexOf('function sqlStatement('), src.indexOf('function sqlRun('));
	const iStmt = sqlStmt.indexOf('undoLog.statement(');
	const iFire = sqlStmt.indexOf('isFaultTarget(m.sql, reply)');
	assert.ok(iStmt > 0 && iFire > iStmt, 'the check runs after the statement (and its frame open) returned');
	assert.match(sqlStmt, /faultPending = false;/, 'one shot');
	assert.match(sqlStmt, /m: 'fault-inject'/, 'logged before the kill');
	assert.match(sqlStmt, /m: 'fault-not-killed'/, 'an isolate that survived is logged');
	assert.match(src, /faultPending = false;\s*\/\/ #730: never carried to the next request/, 'cleared after the request');
});

test('#766 sql-fail: armed only with the var, the spike token and the header; the needle is 3 to 120 characters', () => {
	const h = (o) => new Map(Object.entries(o));
	const env = { FAULT_INJECT: FAULT_SQL_FAIL };
	const ok = h({ [FAULT_HEADER]: FAULT_SQL_FAIL, [FAULT_SQL_HEADER]: 'false-404-mug' });
	assert.equal(sqlFailNeedle(env, true, ok), 'false-404-mug');
	assert.equal(sqlFailNeedle({}, true, ok), null, 'no site var');
	assert.equal(sqlFailNeedle({ FAULT_INJECT: FAULT_AFTER_INSERT }, true, ok), null, 'the other mode does not arm it');
	assert.equal(sqlFailNeedle(env, false, ok), null, 'no spike token');
	assert.equal(sqlFailNeedle(env, true, h({ [FAULT_SQL_HEADER]: 'false-404-mug' })), null, 'no x-pf-fault');
	assert.equal(sqlFailNeedle(env, true, h({ [FAULT_HEADER]: FAULT_AFTER_INSERT, [FAULT_SQL_HEADER]: 'abc' })), null, 'x-pf-fault of the other mode');
	assert.equal(sqlFailNeedle(env, true, h({ [FAULT_HEADER]: FAULT_SQL_FAIL, [FAULT_SQL_HEADER]: 'ab' })), null, 'too short');
	assert.equal(sqlFailNeedle(env, true, h({ [FAULT_HEADER]: FAULT_SQL_FAIL, [FAULT_SQL_HEADER]: 'x'.repeat(121) })), null, 'too long');
	assert.equal(faultArmed(env, true, ok), false, 'sql-fail never arms the after-insert kill');
	assert.ok(MEMORY_RESET.test(SQL_FAIL_MESSAGE), 'the message is one resetFailures counts, as the platform reset is');
	const kind = (k) => sqlFailMessage(h(k ? { [FAULT_SQL_KIND_HEADER]: k } : {}));
	assert.equal(kind(''), SQL_FAIL_MESSAGE, 'the default is the reset');
	assert.equal(kind('busy'), SQL_FAIL_BUSY_MESSAGE, 'busy: a platform failure that is not the reset');
	assert.equal(kind('other'), SQL_FAIL_OTHER_MESSAGE, 'other: a deterministic statement error');
	assert.ok(!MEMORY_RESET.test(SQL_FAIL_BUSY_MESSAGE) && /SQLITE_BUSY/.test(SQL_FAIL_BUSY_MESSAGE));
});
test('#766 index.js wiring: a request with a reset-class failure drops the object-cache keys it wrote, and its held L2 sets', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.ok(src.includes('sqlFailAt = sqlFailNeedle(env, spikeOk, req.headers)'), 'armed per object request');
	assert.ok(src.includes('sqlFailAt = null; // #766: nor this'), 'never carried to the next request');
	assert.ok(/if \(sqlFailAt && String\(m\.sql\)\.includes\(sqlFailAt\)\) \{\s*sqlFailAt = null;/.test(src), 'one shot, before the statement runs');
	assert.ok(src.includes('ocReqBegin(); // #766'), 'each request starts its own record of cache writes');
	assert.ok(src.includes('const ocForgot = ocReqForget();'), 'the write-loss answer forgets them');
	assert.ok(src.includes('if (req0 && req0.poisoned) return;'), 'a held L2 set of a poisoned request never runs');
});
