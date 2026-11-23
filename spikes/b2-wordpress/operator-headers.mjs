// The operator switches PHP reads from request headers. Each is honoured only with a valid spike token: without
// one, handleInner (index.js) removes it before PHP runs. Moved verbatim from index.js first; the rule is below.
// x-pf-conformance-reset (#1401) is read by the throwaway marker (tests/conformance/php/pf-conformance-throwaway.php),
// not by the engine's own php/, and is stripped here like the rest.
export const OPERATOR_PHP_HEADERS = new Set(['x-ast-cache-off', 'x-oc-off', 'x-mem-trace', 'x-mem-off', 'x-pf-wc-defer', 'x-pf-conformance-reset']);
// PHP sees a header as $_SERVER['HTTP_' + name.toUpperCase().replace(/-/g, '_')] (php-wasm), so every name that maps
// to the same key is the same switch: a header is compared by that key, not by its spelling.
const phpKey = (name) => 'HTTP_' + String(name).toUpperCase().replace(/-/g, '_');
const OPERATOR_KEYS = new Set([...OPERATOR_PHP_HEADERS].map(phpKey));
// headers: the plain object index.js passes to PHP (names as Headers.forEach gives them). Mutated and returned.
export function stripOperatorHeaders(headers, spikeOk) {
	if (spikeOk) return headers;
	for (const name of Object.keys(headers)) if (OPERATOR_KEYS.has(phpKey(name))) delete headers[name];
	return headers;
}
