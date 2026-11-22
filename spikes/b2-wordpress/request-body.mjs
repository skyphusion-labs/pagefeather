// #1344: the request body PHP gets. Stock WordPress reads a REST GET's JSON body (WP_REST_Request puts JSON params
// first in its parameter order, for any method), so a GET with a body must reach PHP with it. A GET with no body, or
// an empty one, still sends none; HEAD never does; every other method sends its body as before.
//
// Only where PHP reads the incoming request itself (approach A's Worker). An object path re-builds the request with
// new Request(req), and the Fetch spec refuses a GET with a body there; that path is not changed here.
export async function phpRequestBody(req) {
	if (req.method === 'HEAD') return undefined;
	if (req.method === 'GET') {
		if (!req.body) return undefined;
		const bytes = new Uint8Array(await req.arrayBuffer());
		return bytes.length ? bytes : undefined;
	}
	return new Uint8Array(await req.arrayBuffer());
}
