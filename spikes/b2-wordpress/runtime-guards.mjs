// Two runtime guards for PHP in a Worker (issue #452). Pure code, tested in tests/runtime-guards.test.mjs.
//
// 1. Raw sockets. PHP's fsockopen(), stream_socket_client() and the like reach Emscripten's SOCKFS,
//    which turns a connect into `new WebSocket("ws://<host>:<port>/")` from the Worker. php-wasm then
//    polls that socket with Node EventEmitter calls (ws.once, ws.removeListener) that a workerd
//    WebSocket (an EventTarget) does not have, so every poll waited out its timeout and its cleanup
//    threw "ws.removeListener is not a function": 610 times in one window on pft1a (Wordfence).
//    The documented contract (php/http-bridge.php) is that plugins using raw sockets have no
//    network; outbound HTTP goes through the bridge and its host allowlist. So the socket
//    constructor is replaced (php-wasm's Module.websocket.decorator hook) by one that refuses:
//    SOCKFS catches the throw and the connect fails with an errno, once, with no socket opened.
// 2. Messages from PHP. post_message_to_js() hands index.js a raw string; JSON.parse threw on one
//    that is not JSON (18 times on /wp-login.php, pft1a). parseMessage refuses it with an error.

/**
 * A decorator for Module.websocket: whatever constructor php-wasm passes, return one that refuses.
 * onRefuse(info) is told the scheme, host and port (never a path or query), for one log line.
 */
export function refuseSocketsDecorator(onRefuse) {
	return function decorate() {
		return class RefusedSocket {
			constructor(url) {
				let info = { host: '(unparsed)' };
				try {
					const u = new URL(String(url));
					info = { scheme: u.protocol.replace(':', ''), host: u.hostname, port: u.port || null };
				} catch {
					// a URL php-wasm could not have meant; the refusal stands either way
				}
				try {
					if (onRefuse) onRefuse(info);
				} catch {
					// logging must never turn a clean refusal into another error
				}
				throw new Error('outbound sockets are not available to PHP here; use the WordPress HTTP API');
			}
		};
	};
}

/** Parse one PHP-to-JS message. { ok: true, m } for a JSON object, else { ok: false, error }. */
export function parseMessage(raw) {
	if (typeof raw !== 'string') return { ok: false, error: 'message is not a string' };
	let m;
	try {
		m = JSON.parse(raw);
	} catch {
		return { ok: false, error: 'message is not JSON' };
	}
	if (m === null || typeof m !== 'object' || Array.isArray(m)) return { ok: false, error: 'message is not a JSON object' };
	return { ok: true, m };
}
