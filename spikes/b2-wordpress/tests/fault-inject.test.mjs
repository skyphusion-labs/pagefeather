// node --test spikes/b2-wordpress/tests/fault-inject.test.mjs (#730, #589 B): the operator-only post-INSERT
// fault injector. Armed only by the site var AND the spike token AND the request header; it fires after the
// request's INSERT into wp_posts that changed a row; the kill is a memory exhaustion (the platform's own reset
// path), and an isolate still alive after the cap is reported, never silent. Plus the index.js wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { faultArmed, isFaultTarget, exhaustMemory, FAULT_HEADER, FAULT_AFTER_INSERT } from '../fault-inject.mjs';

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
