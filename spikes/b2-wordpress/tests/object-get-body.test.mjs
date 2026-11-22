// node --test spikes/b2-wordpress/tests/object-get-body.test.mjs (#1352)
// Stock WordPress reads a REST GET's JSON body. #1348 made approach A's Worker pass that body to PHP.
// The object paths (toPhpObjectCall for b-dosql, b-do and the overflow pool; the ovf-self hop) rebuild the
// request with new Request(), and the Fetch spec throws when a GET or HEAD has a body. A non-empty GET is
// forwarded as POST with x-pf-orig-method: GET. The object restores method GET and hands PHP those bytes.
// An empty or bodiless GET is unchanged. HEAD never carries a body. A client cannot set the marker.
// A retry sends the same bytes: the body stream is read once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const JSON_BODY = '{"status":["publish","draft"]}';
const NAV = 'https://site.test/wp-json/wp/v2/navigation';

function bytesOf(text) {
	return new TextEncoder().encode(text);
}
function sameBytes(got, text) {
	const want = bytesOf(text);
	assert.ok(got instanceof Uint8Array, 'bytes');
	assert.equal(got.byteLength, want.byteLength);
	for (let i = 0; i < want.byteLength; i++) assert.equal(got[i], want[i], 'byte ' + i);
}

// A Request cannot be built with a GET body (the Fetch spec throws). This stands in for an incoming one.
function incoming(method, text, headers) {
	const bytes = text === null ? null : bytesOf(text);
	let reads = 0;
	const req = {
		url: NAV,
		method,
		headers: new Headers(headers || {}),
		body: bytes === null ? null : new ReadableStream({ start(c) { if (bytes.length) c.enqueue(bytes); c.close(); } }),
		signal: undefined,
		redirect: 'follow',
		arrayBuffer: async () => {
			reads++;
			if (!bytes || !bytes.byteLength) return new ArrayBuffer(0);
			return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
		},
	};
	req.reads = () => reads;
	return req;
}

test('#1352 a GET with a JSON body reaches the object PHP request as GET with the same bytes', async () => {
	const m = await import('../request-body.mjs');
	const req = incoming('GET', JSON_BODY, { 'content-type': 'application/json', 'x-pf-orig-method': 'DELETE' });
	const carry = await m.carryGetBody(req);
	const sent = m.requestForObjectAttempt(req, carry);
	assert.equal(sent.method, 'POST', 'the wire method is one the Fetch spec allows to carry a body');
	assert.equal(sent.headers.get(m.ORIG_METHOD_HEADER), 'GET', 'our marker, not the client DELETE');
	const restored = m.restoreForwardedGet(sent);
	assert.equal(restored.method, 'GET');
	assert.equal(restored.headers.get(m.ORIG_METHOD_HEADER), null, 'PHP does not see the marker');
	sameBytes(await m.phpRequestBody(restored), JSON_BODY);
	const headers = {};
	restored.headers.forEach((v, k) => (headers[k] = v));
	assert.equal(headers[m.ORIG_METHOD_HEADER], undefined);
	assert.equal(headers['content-type'], 'application/json');
});

test('#1352 an empty GET gets no header and no method change; a bodiless GET is forwarded as today', async () => {
	const m = await import('../request-body.mjs');
	const empty = incoming('GET', '');
	const carry = await m.carryGetBody(empty);
	const sent = m.requestForObjectAttempt(empty, carry);
	assert.equal(sent.method, 'GET');
	assert.equal(sent.headers.get(m.ORIG_METHOD_HEADER), null);
	assert.equal(sent.body, null);
	const plain = new Request(NAV, { headers: { 'x-pf-orig-method': 'POST' } });
	const plainCarry = await m.carryGetBody(plain);
	assert.equal(plainCarry.rebuild, false);
	const forwarded = m.requestForObjectAttempt(plain, plainCarry);
	assert.equal(forwarded.method, 'GET');
	assert.equal(forwarded.headers.get(m.ORIG_METHOD_HEADER), null);
	assert.equal(forwarded.body, null);
});

test('#1352 HEAD never carries a body, and the body stream is not read', async () => {
	const m = await import('../request-body.mjs');
	const req = incoming('HEAD', 'x', { 'x-pf-orig-method': 'GET' });
	req.arrayBuffer = async () => { throw new Error('HEAD body was read'); };
	const carry = await m.carryGetBody(req);
	assert.equal(carry.method, 'HEAD');
	assert.equal(carry.bytes, null);
	const sent = m.requestForObjectAttempt(req, carry);
	assert.equal(sent.method, 'HEAD');
	assert.equal(sent.body, null);
	assert.equal(sent.headers.get(m.ORIG_METHOD_HEADER), null);
	assert.equal(req.reads(), 0);
});

test('#1352 a client-sent x-pf-orig-method is stripped and cannot change the method', async () => {
	const m = await import('../request-body.mjs');
	const post = new Request(NAV, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-pf-orig-method': 'GET' },
		body: JSON_BODY,
	});
	const carry = await m.carryGetBody(post);
	assert.equal(carry.rebuild, false, 'a POST is not rewritten just because the client named GET');
	const sent = m.requestForObjectAttempt(post, carry);
	assert.equal(sent.method, 'POST');
	assert.equal(sent.headers.get(m.ORIG_METHOD_HEADER), null);
	const restored = m.restoreForwardedGet(sent);
	assert.equal(restored.method, 'POST');
	assert.equal(await restored.text(), JSON_BODY);
	const other = new Request(NAV, { method: 'POST', headers: { 'x-pf-orig-method': 'DELETE' }, body: 'a=1' });
	const kept = m.restoreForwardedGet(other);
	assert.equal(kept.method, 'POST');
	assert.equal(kept.headers.get(m.ORIG_METHOD_HEADER), null);
});

test('#1352 a retry re-sends the same bytes, and the body stream is read once', async () => {
	const m = await import('../request-body.mjs');
	const req = incoming('GET', JSON_BODY, { 'content-type': 'application/json' });
	const carry = await m.carryGetBody(req);
	assert.equal(req.reads(), 1);
	const a = m.requestForObjectAttempt(req, carry);
	const b = m.requestForObjectAttempt(req, carry);
	assert.equal(req.reads(), 1, 'the second attempt does not read the stream');
	sameBytes(new Uint8Array(await a.arrayBuffer()), JSON_BODY);
	sameBytes(new Uint8Array(await b.arrayBuffer()), JSON_BODY);
	assert.equal(a.headers.get(m.ORIG_METHOD_HEADER), 'GET');
	assert.equal(b.headers.get(m.ORIG_METHOD_HEADER), 'GET');
});

test('#1352 the ovf-self hop keeps the bytes for a retry after the first forward request is built', async () => {
	const m = await import('../request-body.mjs');
	const wire = m.objectForwardRequest({
		url: NAV,
		method: 'GET',
		headers: { 'content-type': 'application/json', 'x-pf-orig-method': 'PUT' },
		body: bytesOf(JSON_BODY),
		redirect: 'manual',
	});
	assert.equal(wire.method, 'POST');
	assert.equal(wire.headers.get(m.ORIG_METHOD_HEADER), 'GET', 'the client PUT is not the marker');
	assert.equal(wire.redirect, 'manual');
	const carry = await m.carryGetBody(wire);
	assert.equal(wire.bodyUsed, false, 'the retry does not need the first request stream');
	assert.equal(carry.method, 'GET');
	const again = m.requestForObjectAttempt(wire, carry);
	const third = m.requestForObjectAttempt(wire, carry);
	sameBytes(new Uint8Array(await again.arrayBuffer()), JSON_BODY);
	const restored = m.restoreForwardedGet(third);
	assert.equal(restored.method, 'GET');
	sameBytes(await m.phpRequestBody(restored), JSON_BODY);
});

test('#1352 index.js: the three object forwards use the carry, and the object restores GET before PHP', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	const doc = readFileSync(new URL('../request-body.mjs', import.meta.url), 'utf8');
	assert.match(doc, /The object paths now match/);
	const fnStart = src.indexOf('async function toPhpObjectCall(');
	const fn = src.slice(fnStart, src.indexOf('\n}\n', fnStart));
	assert.ok(fn.indexOf('carryGetBody(req)') > 0 && fn.indexOf('carryGetBody(req)') < fn.indexOf('fetchWithMemoryRetry('), 'read once, before the retry');
	assert.ok(fn.indexOf('requestForObjectAttempt(req, carry)') > fn.indexOf('fetchWithMemoryRetry('), 'each attempt builds its own request');
	assert.match(fn, /method: origMethod/);
	assert.match(fn, /objectErrorOutcome\(kind, origMethod\)/);
	assert.match(src, /toPhpObject\(busyOk \? req\.clone\(\) : req,/);
	assert.match(src, /objectForwardRequest\(\{ url, method, headers, body, signal, redirect: 'manual' \}\)/);
	const obj = src.slice(src.indexOf('export class PhpRuntime extends DurableObject {'), src.indexOf('function phpObjectName('));
	const restored = obj.indexOf('req = restoreForwardedGet(req);');
	const handle = obj.indexOf('handle(req, env, url, spikeOk, maxBody, ctx)');
	assert.ok(restored > 0 && handle > restored, 'the object restores the method before PHP runs');
	assert.match(src, /body = await phpRequestBody\(req\);/);
	assert.match(src, /handler\.request\(\{ url: url\.pathname \+ url\.search, method: req\.method, headers, body \}\)/);
});
