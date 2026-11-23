// The body each attempt of a memory-reset retry sends (#1352).
//
// toPhpObjectCall used to build `new Request(req)` inside the send callback.
// That constructor takes the original body (the stream is disturbed). The next
// attempt throws "already been used", so the retry never reaches the object
// and the body is not sent again.
//
// readRetryBody reads the bytes once when the attempt is built from those
// bytes. A Request is read from a clone, so the original stays usable.
// attemptRequest sends those bytes on every attempt.
//
// A GET or HEAD body cannot be set in Request init. Node and workerd throw
// "Request with a GET or HEAD method cannot have a body." workerd allows the
// body only when the new request copies one that already has it. A GET or HEAD
// Request is copied with clone() on each attempt, which re-sends the same bytes.
// A test stand-in (request-body.test.mjs) is not a Request. The bytes are
// attached on a fresh object the stub reads.
//
// A method that is not retried (anything but GET, HEAD or OPTIONS) is forwarded
// once, with new Request(req). Its body is not buffered.
import { RETRY_METHODS } from './object-error.mjs';

export async function readRetryBody(req) {
	const method = String((req && req.method) || 'GET').toUpperCase();
	if (!RETRY_METHODS.has(method)) return null;
	if (!req || req.body == null || method === 'HEAD') return null;
	// A GET Request already carries the body. clone() copies it. Putting the
	// bytes into Request init would throw.
	if (req instanceof Request && method === 'GET') return null;
	const src = req instanceof Request ? req.clone() : req;
	const view = new Uint8Array(await src.arrayBuffer());
	const out = new Uint8Array(view.byteLength);
	out.set(view);
	if (method === 'GET' && out.byteLength === 0) return null;
	return out;
}

export function attemptRequest(req, bytes) {
	const method = String((req && req.method) || 'GET').toUpperCase();
	if (!RETRY_METHODS.has(method)) return new Request(req);
	if (req instanceof Request && (method === 'GET' || method === 'HEAD')) return new Request(req.clone());
	if (!(req instanceof Request)) return standIn(req, bytes);
	const init = { method, headers: new Headers(req.headers) };
	if (bytes) init.body = bytes.slice();
	return new Request(req.url, init);
}

function standIn(req, bytes) {
	const u = bytes && bytes.byteLength ? bytes.slice() : null;
	return {
		method: req.method,
		url: req.url,
		headers: req.headers ? new Headers(req.headers) : new Headers(),
		body: u ? new ReadableStream({ start(c) { c.enqueue(u); c.close(); } }) : null,
		arrayBuffer: async () => {
			const v = u || new Uint8Array(0);
			const out = new ArrayBuffer(v.byteLength);
			new Uint8Array(out).set(v);
			return out;
		},
	};
}
