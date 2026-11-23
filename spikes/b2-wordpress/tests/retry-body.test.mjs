// node --test spikes/b2-wordpress/tests/retry-body.test.mjs (#1352)
// fetchWithMemoryRetry sends a GET, HEAD or OPTIONS once more after a memory reset.
// toPhpObjectCall builds the forwarded request on each attempt. A body can be read
// once, so the retry must carry the same bytes as the first attempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchWithMemoryRetry } from '../object-error.mjs';
import { readRetryBody, attemptRequest } from '../retry-body.mjs';

const JSON_BODY = '{"status":["publish","draft"]}';
const reset = Object.assign(new Error("Durable Object's isolate exceeded its memory limit and was reset."), { overloaded: true });

// The same stand-in as request-body.test.mjs: a Request cannot be built with a GET
// body (the Fetch spec throws), but an incoming request can carry one. url and
// headers are added so the forward has something to copy.
function incoming(method, text) {
	const bytes = text === null ? null : new TextEncoder().encode(text);
	return {
		method,
		url: 'https://site.example/wp/v2/navigation',
		headers: new Headers(text ? { 'content-type': 'application/json' } : {}),
		body: bytes === null ? null : new ReadableStream({ start(c) { if (bytes.length) c.enqueue(bytes); c.close(); } }),
		arrayBuffer: async () => (bytes || new Uint8Array(0)).buffer,
	};
}

function decode(bytes) {
	return new TextDecoder().decode(bytes);
}

async function drive(req) {
	const replay = await readRetryBody(req);
	const seen = [];
	const stub = {
		async fetch(fwd) {
			const bytes = fwd.body == null ? new Uint8Array(0) : new Uint8Array(await fwd.arrayBuffer());
			seen.push(bytes);
			if (seen.length === 1) throw reset;
			return new Response('ok');
		},
	};
	try {
		const result = await fetchWithMemoryRetry(() => stub.fetch(attemptRequest(req, replay)), req.method);
		return { result, seen };
	} catch (e) {
		return { threw: e, seen };
	}
}

test('#1352: a GET JSON body is on the retry after a memory reset', async () => {
	const out = await drive(incoming('GET', JSON_BODY));
	assert.equal(out.threw, undefined, out.threw && out.threw.message);
	assert.equal(out.result.attempts, 2);
	assert.equal(out.seen.length, 2);
	assert.equal(decode(out.seen[0]), JSON_BODY);
	assert.equal(decode(out.seen[1]), JSON_BODY);
});

// OPTIONS is retried, like GET, and the Request constructor allows its body.
// A GET Request with a body cannot be built here (the same throw as request-body.test.mjs).
test('#1352: a Request body is on the retry after a memory reset', async () => {
	const req = new Request('https://site.example/wp/v2/navigation', {
		method: 'OPTIONS',
		body: JSON_BODY,
		headers: { 'content-type': 'application/json' },
	});
	const out = await drive(req);
	assert.equal(out.threw, undefined, out.threw && out.threw.message);
	assert.equal(out.result.attempts, 2);
	assert.equal(out.seen.length, 2);
	assert.equal(decode(out.seen[0]), JSON_BODY);
	assert.equal(decode(out.seen[1]), JSON_BODY);
});

// Node's Request constructor throws on a GET body. Workers delivers one (measured
// on #1352). This reports method GET and still has the bytes, so the GET Request
// branch runs: clone() on each attempt, not Request init.
function getRequestWithBody(text) {
	const real = new Request('https://site.example/wp/v2/navigation', {
		method: 'POST',
		body: text,
		headers: { 'content-type': 'application/json' },
	});
	return new Proxy(real, {
		get(target, prop) {
			if (prop === 'method') return 'GET';
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

test('#1352: a GET Request is cloned per attempt and both fetches get the body', async () => {
	const req = getRequestWithBody(JSON_BODY);
	const replay = await readRetryBody(req);
	assert.equal(replay, null, 'a GET Request is copied with clone(), not buffered into Request init');
	const out = await drive(req);
	assert.equal(out.threw, undefined, out.threw && out.threw.message);
	assert.equal(out.result.attempts, 2);
	assert.equal(out.seen.length, 2);
	assert.equal(decode(out.seen[0]), JSON_BODY);
	assert.equal(decode(out.seen[1]), JSON_BODY);
});

test('#1352: a POST body is on the one fetch; a memory reset does not retry a POST', async () => {
	const req = new Request('https://site.example/wp-admin/post.php', {
		method: 'POST',
		body: 'a=1&b=2',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
	});
	const out = await drive(req);
	assert.equal(out.threw, undefined, out.threw && out.threw.message);
	assert.equal(out.result.kind, 'memory');
	assert.equal(out.result.attempts, 1);
	assert.equal(out.seen.length, 1);
	assert.equal(decode(out.seen[0]), 'a=1&b=2');
});

test('index.js reads the retry body once and forwards each attempt through attemptRequest', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /import \{ readRetryBody, attemptRequest \} from '\.\/retry-body\.mjs';/);
	const i = src.indexOf('async function toPhpObjectCall(');
	const body = src.slice(i, src.indexOf('\n}\n', i));
	const readAt = body.indexOf('const replay = await readRetryBody(req);');
	const sendAt = body.indexOf('fetchWithMemoryRetry(');
	const fwdAt = body.indexOf('const fwd = attemptRequest(req, replay);');
	assert.ok(readAt > 0 && readAt < sendAt, 'the body is read before the first attempt');
	assert.ok(fwdAt > sendAt, 'each attempt forwards through attemptRequest');
});
