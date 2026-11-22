// node --test spikes/b2-wordpress/tests/request-body.test.mjs (#1344)
// Stock WordPress reads a REST GET's JSON body: WP_REST_Request's JSON params come first in its parameter order, for any
// method. The gb navigation spec "single Navigation Menu" lists menus with GET /wp/v2/navigation and a JSON body
// {"status":["publish","draft"]}. On approach A the engine passed NO body to PHP for every GET (index.js handle():
// ['GET','HEAD'].includes(req.method) ? undefined), so the draft was missing (cf759hw, joan, 2026-11-22).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// A Request cannot be built with a GET body (the Fetch spec throws), but an INCOMING request can carry one. This
// stands in for one: the method, a body stream (or null), and arrayBuffer().
function incoming(method, text) {
	const bytes = text === null ? null : new TextEncoder().encode(text);
	return {
		method,
		body: bytes === null ? null : new ReadableStream({ start(c) { if (bytes.length) c.enqueue(bytes); c.close(); } }),
		arrayBuffer: async () => (bytes || new Uint8Array(0)).buffer,
	};
}
test('#1344 phpRequestBody: a GET with a JSON body reaches PHP', async () => {
	const m = await import('../request-body.mjs');
	const b = await m.phpRequestBody(incoming('GET', '{"status":["publish","draft"]}'));
	assert.ok(b instanceof Uint8Array, 'bytes');
	assert.equal(new TextDecoder().decode(b), '{"status":["publish","draft"]}');
});
test('#1344 phpRequestBody: a GET with no body, or an empty one, sends none (unchanged)', async () => {
	const m = await import('../request-body.mjs');
	assert.equal(await m.phpRequestBody(incoming('GET', null)), undefined);
	assert.equal(await m.phpRequestBody(incoming('GET', '')), undefined);
});
test('#1344 phpRequestBody: HEAD never sends a body; other methods always do (unchanged)', async () => {
	const m = await import('../request-body.mjs');
	assert.equal(await m.phpRequestBody(incoming('HEAD', 'x')), undefined);
	assert.equal(new TextDecoder().decode(await m.phpRequestBody(incoming('POST', 'a=1'))), 'a=1');
	assert.equal((await m.phpRequestBody(incoming('POST', ''))).length, 0, 'an empty POST body stays an empty body');
});
test('#1344 index.js: handle() takes the PHP body from phpRequestBody, not a GET/HEAD rule of its own', () => {
	const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
	assert.match(src, /body = await phpRequestBody\(req\);/);
	assert.doesNotMatch(src, /body = \['GET', 'HEAD'\]\.includes\(req\.method\) \? undefined : new Uint8Array\(await req\.arrayBuffer\(\)\);/);
});
