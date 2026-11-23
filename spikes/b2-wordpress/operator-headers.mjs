// The operator switches PHP reads from request headers. Each is honoured only with a valid spike token: without
// one, handleInner (index.js) removes it before PHP runs. Moved verbatim from index.js first; the rule is below.
export const OPERATOR_PHP_HEADERS = new Set(['x-ast-cache-off', 'x-oc-off', 'x-mem-trace', 'x-mem-off', 'x-pf-wc-defer']);
// headers: the plain object index.js passes to PHP (names as Headers.forEach gives them). Mutated and returned.
export function stripOperatorHeaders(headers, spikeOk) {
	if (spikeOk) return headers;
	for (const name of OPERATOR_PHP_HEADERS) delete headers[name];
	return headers;
}
