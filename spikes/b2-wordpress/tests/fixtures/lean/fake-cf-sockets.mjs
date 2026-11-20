// A stand-in for cloudflare:sockets (#1101 tests): connect() is never called by the destroy test, which builds a
// LeanMysql on its own fake socket.
export function connect() {
	throw new Error('fake cloudflare:sockets: connect is not used in these tests');
}
