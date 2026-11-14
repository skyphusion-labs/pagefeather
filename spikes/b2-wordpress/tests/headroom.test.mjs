// node --test spikes/b2-wordpress/tests/headroom.test.mjs (#394, /_headroom)
// The headroom probe: after a real request, the SAME isolate allocates 1 MiB ArrayBuffers, each filled
// and HELD, and streams the running count until a step throws or the isolate dies. Measured on throwaway
// Workers first (#394 floor rounds 1 to 6: A2 reached 255). Here it runs inside the PHP object, so
// 255 minus the reach minus the live wasm heap is what the runtime holds outside the wasm heap.
// Off by default (HEADROOM_PROBE=on), and spike-gated like every /_ path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { headroomStream } from '../headroom.mjs';

async function readAll(res) {
	const r = res.body.getReader();
	let s = '';
	const d = new TextDecoder();
	for (;;) {
		const { value, done } = await r.read();
		if (done) break;
		s += d.decode(value, { stream: true });
	}
	return s;
}

test('headroom streams the first line, then one "mib N" per held MiB, then done', async () => {
	const { response, job } = headroomStream({ first: '{"at":"headroom"}', max: 3 });
	const [text] = await Promise.all([readAll(response), job]);
	assert.deepEqual(text.trim().split('\n'), ['{"at":"headroom"}', 'mib 1', 'mib 2', 'mib 3', 'done 3 held 3']);
	assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('headroom reports a throw with the count reached, and still ends the stream', async () => {
	let n = 0;
	const alloc = () => { if (++n > 2) throw new RangeError('Array buffer allocation failed'); return new ArrayBuffer(16); };
	const { response, job } = headroomStream({ first: 'x', max: 10, alloc });
	const [text] = await Promise.all([readAll(response), job]);
	assert.deepEqual(text.trim().split('\n'), ['x', 'mib 1', 'mib 2', 'threw at 2 Array buffer allocation failed']);
});

test('max is clamped to 1..4096', async () => {
	const { response, job } = headroomStream({ first: 'x', max: 0 });
	const [text] = await Promise.all([readAll(response), job]);
	assert.match(text, /^x\nmib 1\ndone 1 held 1\n$/);
});

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
test('index.js: /_headroom is off by default, sits after the spike check and before the PHP lock, and logs the ledger first', () => {
	const at = src.indexOf("if (url.pathname === '/_headroom')");
	assert.ok(at > 0, 'the route exists');
	const spike = src.lastIndexOf("if (url.pathname.startsWith('/_') && !spikeOk) return new Response('forbidden', { status: 403 });", at);
	assert.ok(spike > 0 && at - spike < 4000, 'after the object spike check');
	assert.ok(src.indexOf('return withPhp(async () => {', at) > at, 'before the PHP lock');
	const block = src.slice(at, at + 900);
	assert.match(block, /env\.HEADROOM_PROBE !== 'on'\) return new Response\('Not Found', \{ status: 404 \}\)/);
	assert.match(block, /ledgerSnapshot\('headroom'\)/);
	assert.match(block, /this\.ctx\.waitUntil\(job\)/);
});
