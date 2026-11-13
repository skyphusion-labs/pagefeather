// node --test spikes/b2-wordpress/tests/runtime-guards.test.mjs (issue #452)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refuseSocketsDecorator, parseMessage } from '../runtime-guards.mjs';

// The CONTROL: php-wasm's awaitEvent (vendor/php_8_3.js, from @php-wasm/web-8-3 3.1.62) against a
// workerd-style WebSocket (an EventTarget: addEventListener only). This is the defect: the cancel
// throws, every time. If this ever stops throwing, the premise of the guard has changed.
function stockAwaitEvent(ws, event) {
	let resolve;
	const listener = () => resolve();
	const promise = new Promise(function (_resolve) {
		resolve = _resolve;
		ws.once(event, listener);
	});
	const cancel = () => {
		ws.removeListener(event, listener);
		setTimeout(resolve);
	};
	return [promise, cancel];
}
class WorkerdLikeSocket extends EventTarget {}

test('control: the stock poll on a workerd-style socket rejects, and its cleanup throws', async () => {
	const [promise, cancel] = stockAwaitEvent(new WorkerdLikeSocket(), 'message');
	await assert.rejects(promise, /once is not a function/);
	assert.throws(cancel, /removeListener is not a function/);
});

test('the decorator refuses: constructing the socket throws, nothing is opened, one report', () => {
	const seen = [];
	let opened = 0;
	class RealSocket {
		constructor() {
			opened++;
		}
	}
	const Decorated = refuseSocketsDecorator((i) => seen.push(i))(RealSocket);
	assert.throws(() => new Decorated('ws://noc1.wordfence.com:443/', ['binary']), /outbound sockets are not available to PHP/);
	assert.equal(opened, 0, 'the real constructor is never called');
	assert.deepEqual(seen, [{ scheme: 'ws', host: 'noc1.wordfence.com', port: '443' }]);
});

test('the report carries scheme, host and port only, never the path or query', () => {
	const seen = [];
	const D = refuseSocketsDecorator((i) => seen.push(i))(class {});
	assert.throws(() => new D('wss://example.com/secret/path?token=abc'));
	assert.deepEqual(seen, [{ scheme: 'wss', host: 'example.com', port: null }]);
	assert.ok(!JSON.stringify(seen).includes('token'));
});

test('an unparsable URL is still refused, and a throwing logger does not change the refusal', () => {
	const D = refuseSocketsDecorator(() => {
		throw new Error('logger down');
	})(class {});
	assert.throws(() => new D('not a url'), /outbound sockets are not available/);
	const E = refuseSocketsDecorator()(class {});
	assert.throws(() => new E('ws://x:1/'), /outbound sockets are not available/);
});

test('the SOCKFS shape: a throw inside its try becomes a failed connect, not a crash', () => {
	// vendor/php_8_3.js wraps `ws = new WebSocketConstructor(url, opts)` in try { } catch (e) { throw new FS.ErrnoError(23) }.
	class ErrnoError extends Error {
		constructor(errno) {
			super('errno ' + errno);
			this.errno = errno;
		}
	}
	const WebSocketConstructor = refuseSocketsDecorator()(class {});
	let caught;
	try {
		try {
			new WebSocketConstructor('ws://example.com:80/', []);
		} catch (e) {
			throw new ErrnoError(23);
		}
	} catch (e) {
		caught = e;
	}
	assert.equal(caught.errno, 23);
});

test('parseMessage: a JSON object passes; anything else is refused with a reason, never a throw', () => {
	assert.deepEqual(parseMessage('{"r2":{"op":"get"}}'), { ok: true, m: { r2: { op: 'get' } } });
	for (const [raw, why] of [
		['hello', 'message is not JSON'],
		['', 'message is not JSON'],
		['{"a":', 'message is not JSON'],
		['null', 'message is not a JSON object'],
		['[1,2]', 'message is not a JSON object'],
		['42', 'message is not a JSON object'],
		[undefined, 'message is not a string'],
		[{ a: 1 }, 'message is not a string'],
	]) {
		assert.deepEqual(parseMessage(raw), { ok: false, error: why }, String(raw));
	}
});
