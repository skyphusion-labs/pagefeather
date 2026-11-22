// #1344: the request body PHP gets. Stock WordPress reads a REST GET's JSON body (WP_REST_Request puts JSON params
// first in its parameter order, for any method), so a GET with a body must reach PHP with it. A GET with no body, or
// an empty one, still sends none; HEAD never does; every other method sends its body as before.
//
// The object paths now match (#1352): a non-empty GET is forwarded as POST with x-pf-orig-method: GET, and the object restores method GET with these same bytes.
export const ORIG_METHOD_HEADER = 'x-pf-orig-method';

// Bytes for a GET we already turned into a POST. Keyed by that Request, so a later
// attempt (a memory retry, or toPhpObjectCall after the ovf-self hop) resends them
// without reading the stream again. A clone does not keep this; the header on the
// wire is what the other isolate trusts, and only after this module set it.
const carriedGets = new WeakMap();

export async function phpRequestBody(req) {
	if (req.method === 'HEAD') return undefined;
	if (req.method === 'GET') {
		if (!req.body) return undefined;
		const bytes = new Uint8Array(await req.arrayBuffer());
		return bytes.length ? bytes : undefined;
	}
	return new Uint8Array(await req.arrayBuffer());
}

function asBytes(body) {
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (typeof body === 'string') return new TextEncoder().encode(body);
	return null;
}

// Read a GET body once, before any forward. rebuild means the caller must not copy
// the request with new Request(req): the stream is used up, or the method cannot
// carry a body. bytes is the exact GET body, or null when the forward has none.
// A POST is never rewritten here, even when a client sent x-pf-orig-method.
export async function carryGetBody(req) {
	const pre = req && carriedGets.get(req);
	if (pre) return { rebuild: true, method: 'GET', bytes: pre };
	const method = String((req && req.method) || 'GET').toUpperCase();
	if (method === 'HEAD') return { rebuild: !!(req && req.body), method: 'HEAD', bytes: null };
	if (method === 'GET' && req && req.body) {
		const raw = await req.arrayBuffer();
		const bytes = raw instanceof Uint8Array ? new Uint8Array(raw) : new Uint8Array(raw);
		return { rebuild: true, method: 'GET', bytes: bytes.byteLength ? bytes : null };
	}
	return { rebuild: false, method, bytes: null };
}

// One request the Fetch spec allows. A non-empty GET goes out as POST with the marker
// set to GET (any client value is dropped first). HEAD never has a body. Anything else
// keeps its method, and the marker is omitted.
export function objectForwardRequest({ url, method, headers, body, signal, redirect } = {}) {
	const h = new Headers(headers || {});
	h.delete(ORIG_METHOD_HEADER);
	const m = String(method || 'GET').toUpperCase();
	const init = { method: m, headers: h };
	if (signal) init.signal = signal;
	if (redirect) init.redirect = redirect;
	const bytes = asBytes(body);
	if (m === 'HEAD') return new Request(url, init);
	if (m === 'GET') {
		if (bytes && bytes.byteLength) {
			h.set(ORIG_METHOD_HEADER, 'GET');
			h.set('content-length', String(bytes.byteLength));
			init.method = 'POST';
			init.body = bytes;
			const sent = new Request(url, init);
			carriedGets.set(sent, bytes);
			return sent;
		}
		return new Request(url, init);
	}
	if (bytes) {
		h.set('content-length', String(bytes.byteLength));
		init.body = bytes;
	} else if (body != null) {
		init.body = body;
	}
	return new Request(url, init);
}

// The request one attempt sends. A carried GET builds a fresh POST from the same bytes
// (a retry never re-reads the stream). Every other request is copied as today, and a
// client marker is dropped so it cannot name the method.
export function requestForObjectAttempt(req, carry) {
	if (carry && carry.rebuild) {
		return objectForwardRequest({
			url: req.url,
			method: carry.method,
			headers: req.headers,
			body: carry.bytes,
			signal: req.signal,
			redirect: req.redirect,
		});
	}
	const fwd = new Request(req);
	fwd.headers.delete(ORIG_METHOD_HEADER);
	return fwd;
}

// The object received our POST. PHP must see GET. Request.method cannot be changed,
// and a GET Request cannot hold the body, so the method read by the rest of this
// request is GET while the body stays on the transport request. Any other marker
// is dropped and the method stays what it was.
function withGetMethod(req) {
	return new Proxy(req, {
		get(target, prop) {
			if (prop === 'method') return 'GET';
			// The receiver is the real Request. A getter on the proxy fails its brand check.
			const value = Reflect.get(target, prop, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

export function restoreForwardedGet(req) {
	if (!req || !req.headers || typeof req.headers.get !== 'function') return req;
	const marker = req.headers.get(ORIG_METHOD_HEADER);
	if (marker == null) return req;
	req.headers.delete(ORIG_METHOD_HEADER);
	if (req.method === 'POST' && marker === 'GET') return withGetMethod(req);
	return req;
}
