// The in-isolate object cache cap (#963).
// A suite-hot admin write already holds a full cache beside a wasm heap near 117 MiB.
// That sum crosses the 128 MiB isolate cap. post.php and admin-ajax.php ask for 1 MiB
// for that one request. ocReqBegin puts the 8 MiB cap back on the next request.
export const OBJECT_CACHE_MAX_BYTES = 8 * 1024 * 1024;
export const PRODUCT_ADMIN_OC_BYTES = 1 * 1024 * 1024;
const OC_CAP_FLOOR = 256 * 1024;

// The next cap for an object-cache op, or the current cap when op is not a cap.
export function nextObjectCacheCap(op, current = OBJECT_CACHE_MAX_BYTES) {
	if (!op || op.op !== 'cap') return current;
	const n = op.n;
	if (!Number.isInteger(n)) return current;
	if (n < OC_CAP_FLOOR) return OC_CAP_FLOOR;
	if (n > OBJECT_CACHE_MAX_BYTES) return OBJECT_CACHE_MAX_BYTES;
	return n;
}
