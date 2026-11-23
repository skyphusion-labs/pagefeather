// #1328 (the lead's ruling): link the events of one request. Every Observability row has its own traceId, and a request
// answered without PHP logs no m: line, so two reads of the same leaked cookie GET disagreed on timing alone. A client sends
// x-pf-probe: <id> (8 to 64 of A-Z a-z 0-9 -); the Worker logs m: probe-trace with that id at each entrypoint it reaches:
//   gateway            the default entrypoint's fetch (every request our code sees first);
//   gateway-loopback   the same, for the #1296 hand-off's loopback render (x-pf-pages-render: 1, on the #1277 arms only);
//   pages              the Pages entrypoint (only on a Pages MISS: a cached Pages answer never runs this code);
//   php                a PHP run starts.
// A GET whose id is on NO line was answered before any of our code ran. The id is not part of any cache key. The query
// string is never logged (a store's URLs carry order keys).
export const PROBE_TRACE_HEADER = 'x-pf-probe';
const ID = /^[A-Za-z0-9-]{8,64}$/;
const LOOPBACK_HEADER = 'x-pf-pages-render';

export function probeTraceId(req) {
	const v = req && req.headers ? req.headers.get(PROBE_TRACE_HEADER) : null;
	return v && ID.test(v) ? v : null;
}

export function probeTrace(req, ep, { log = (o) => console.log(JSON.stringify(o)), iso = null, now = Date.now } = {}) {
	const id = probeTraceId(req);
	if (!id) return;
	let path = '';
	try { path = new URL(req.url).pathname; } catch { /* no url */ }
	const where = ep === 'gateway' && req.headers.get(LOOPBACK_HEADER) === '1' ? 'gateway-loopback' : ep;
	// #1277 (the main measurement): the isolate id and the handler start tie a tagged request to its isolate.
	log({ m: 'probe-trace', id, ep: where, method: req.method, path, iso, at: now() });
}
