// db-snapshot.mjs (#533): the scheduled snapshot into the site's own bucket.
//   node --test spikes/b2-wordpress/tests/db-snapshot.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { SNAPSHOT_HEADER, SNAPSHOT_PREFIX, sameToken, snapshotGate, gateResponse, snapshotKey, takeSnapshot } from '../db-snapshot.mjs';

const enc = new TextEncoder();
// A dump like index.js dumpTo: one line per write, then close.
const dumpOf = (lines) => async (writer) => {
	for (const o of lines) await writer.write(enc.encode(JSON.stringify(o) + '\n'));
	await writer.close();
};
const LINES = [{ sql: 'CREATE TABLE t (a)' }, { sql: 'INSERT INTO t (a) VALUES (?)', params: [1] }, { sql: 'INSERT INTO t (a) VALUES (?)', params: [2] }, { end: true, rows: 2 }];
function bucket({ headSize } = {}) {
	const store = new Map();
	return {
		store,
		async put(k, v, o) { store.set(k, { bytes: new Uint8Array(v), opts: o }); },
		async head(k) { const x = store.get(k); return x ? { size: headSize ?? x.bytes.byteLength } : null; },
	};
}
const req = (method, token) => new Request('https://snapshot.internal/_dbsnapshot', { method, headers: token === undefined ? {} : { [SNAPSHOT_HEADER]: token } });
const NOW = Date.UTC(2026, 10, 14, 7, 17, 3);

test('sameToken: equal only for the same non-empty string', () => {
	assert.equal(sameToken('abc', 'abc'), true);
	assert.equal(sameToken('abd', 'abc'), false);
	assert.equal(sameToken('ab', 'abc'), false);
	assert.equal(sameToken('abcd', 'abc'), false);
	assert.equal(sameToken('', ''), false);
});

test('the gate: no token on the site, a wrong token, no header: all 403; a right token with GET: 405', () => {
	assert.equal(snapshotGate(req('POST', 'x'), {}), 'forbidden');
	assert.equal(snapshotGate(req('POST', 'x'), { SNAPSHOT_TOKEN: '' }), 'forbidden');
	assert.equal(snapshotGate(req('POST', 'wrong'), { SNAPSHOT_TOKEN: 'right' }), 'forbidden');
	assert.equal(snapshotGate(req('POST'), { SNAPSHOT_TOKEN: 'right' }), 'forbidden');
	assert.equal(snapshotGate(req('GET', 'wrong'), { SNAPSHOT_TOKEN: 'right' }), 'forbidden');
	assert.equal(snapshotGate(req('GET', 'right'), { SNAPSHOT_TOKEN: 'right' }), 'method');
	assert.equal(snapshotGate(req('POST', 'right'), { SNAPSHOT_TOKEN: 'right' }), 'ok');
	// The spike token is a different key: it never opens this route.
	assert.equal(snapshotGate(new Request('https://x/_dbsnapshot', { method: 'POST', headers: { 'x-spike-token': 'right' } }), { SNAPSHOT_TOKEN: 'right', SPIKE_TOKEN: 'right' }), 'forbidden');
	assert.equal(gateResponse('forbidden').status, 403);
	assert.equal(gateResponse('method').status, 405);
});

test('snapshotKey: under _snapshots/auto/, UTC, sorts in time order', () => {
	assert.equal(snapshotKey(NOW), '_snapshots/auto/20261114T071703Z.ndjson.gz');
	assert.ok(snapshotKey(NOW).startsWith(SNAPSHOT_PREFIX));
	assert.ok(snapshotKey(NOW) < snapshotKey(NOW + 1000));
});

test('ok: the gzipped dump is stored, read back, and gunzips to the exact dump', async () => {
	const b = bucket();
	const r = await takeSnapshot({ dump: dumpOf(LINES), media: b, now: NOW, build: 'b1' });
	assert.equal(r.status, 200, JSON.stringify(r.body));
	assert.equal(r.body.ok, true);
	assert.equal(r.body.rows, 2);
	assert.equal(r.body.key, '_snapshots/auto/20261114T071703Z.ndjson.gz');
	const stored = b.store.get(r.body.key);
	assert.equal(stored.bytes.byteLength, r.body.bytes);
	const want = LINES.map((o) => JSON.stringify(o) + '\n').join('');
	assert.equal(gunzipSync(stored.bytes).toString(), want);
	assert.equal(r.body.rawBytes, Buffer.byteLength(want));
	assert.deepEqual(stored.opts.customMetadata, { rows: '2', rawBytes: String(Buffer.byteLength(want)), build: 'b1' });
	assert.equal(stored.opts.httpMetadata.contentType, 'application/gzip');
});

test('a large dump (40000 rows) stores whole', async () => {
	const lines = [{ sql: 'CREATE TABLE t (a, b)' }];
	for (let i = 0; i < 40000; i++) lines.push({ sql: 'INSERT INTO t (a, b) VALUES (?, ?)', params: [i, 'row ' + i] });
	lines.push({ end: true, rows: 40000 });
	const b = bucket();
	const r = await takeSnapshot({ dump: dumpOf(lines), media: b, now: NOW });
	assert.equal(r.status, 200);
	assert.equal(gunzipSync(b.store.get(r.body.key).bytes).toString().split('\n').filter(Boolean).length, 40002);
});

test('import held: 409, nothing stored, the dump is never started', async () => {
	const b = bucket();
	let started = false;
	const r = await takeSnapshot({ dump: async (w) => { started = true; await w.close(); }, media: b, now: NOW, held: true });
	assert.equal(r.status, 409);
	assert.equal(r.body.error, 'import-held');
	assert.equal(b.store.size, 0);
	assert.equal(started, false);
});

test('an error line in the dump: 500 dump-error, nothing stored', async () => {
	const b = bucket();
	const r = await takeSnapshot({ dump: dumpOf([{ sql: 'CREATE TABLE t (a)' }, { error: 'no such table' }]), media: b, now: NOW });
	assert.equal(r.status, 500);
	assert.equal(r.body.error, 'dump-error');
	assert.match(r.body.detail, /no such table/);
	assert.equal(b.store.size, 0);
});

test('a dump that throws: 500 dump-error, nothing stored', async () => {
	const b = bucket();
	const r = await takeSnapshot({ dump: async () => { throw new Error('boom'); }, media: b, now: NOW });
	assert.equal(r.status, 500);
	assert.equal(r.body.error, 'dump-error');
	assert.equal(b.store.size, 0);
});

test('no end line (a cut dump): 500 dump-empty, nothing stored', async () => {
	const b = bucket();
	const r = await takeSnapshot({ dump: dumpOf([{ sql: 'CREATE TABLE t (a)' }]), media: b, now: NOW });
	assert.equal(r.status, 500);
	assert.equal(r.body.error, 'dump-empty');
	assert.equal(b.store.size, 0);
	const r2 = await takeSnapshot({ dump: dumpOf([]), media: b, now: NOW });
	assert.equal(r2.body.error, 'dump-empty');
});

test('over the raw cap: 413 too-big, nothing stored, and the dump still ends', async () => {
	const b = bucket();
	const r = await takeSnapshot({ dump: dumpOf(LINES), media: b, now: NOW, maxRawBytes: 40 });
	assert.equal(r.status, 413);
	assert.equal(r.body.error, 'too-big');
	assert.equal(b.store.size, 0);
});

test('a readback that does not match the bytes sent: 500 readback', async () => {
	const b = bucket({ headSize: 1 });
	const r = await takeSnapshot({ dump: dumpOf(LINES), media: b, now: NOW });
	assert.equal(r.status, 500);
	assert.equal(r.body.error, 'readback');
});
