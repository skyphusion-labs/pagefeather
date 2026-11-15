// The PHP runtime recycle decision (#598), out of index.js so it is testable (tests/recycle-line.test.mjs).
//
// After each request, index.js drops the runtime when its WebAssembly memory passed the recycle line, so the
// next request boots a fresh one. A dropped memory is collected late (about 120 s on pf571r), and a DO keeps
// its isolate unless the platform replaces it. When the heap ends between our line and the platform's
// replacement point, the dropped memory stays and the next boot stacks a second one: pf582t (the lean engine,
// #582) ended editor pages at 109 to 114 MiB and lost 20 of 70 to memory resets that way.
//
// RECYCLE_WASM_MIB moves the line: an integer from 64 to 240 (MiB). Unset or empty keeps today's 100. A bad
// value keeps 100 and says why (refused), so a typo never turns the recycle off or onto every request. The
// value to ship is set by a measured window, not here (the lead's ruling, #598).
export const RECYCLE_DEFAULT_MIB = 100;
const MiB = 1048576;

export function recycleLine(env) {
	const v = env ? env.RECYCLE_WASM_MIB : undefined;
	if (v === undefined || v === null || v === '') return { bytes: RECYCLE_DEFAULT_MIB * MiB, mib: RECYCLE_DEFAULT_MIB, source: 'default' };
	const s = String(v);
	const n = /^[0-9]{2,3}$/.test(s) ? Number(s) : NaN;
	if (!(n >= 64 && n <= 240)) {
		return { bytes: RECYCLE_DEFAULT_MIB * MiB, mib: RECYCLE_DEFAULT_MIB, source: 'default', refused: 'RECYCLE_WASM_MIB must be an integer from 64 to 240, not ' + JSON.stringify(s) };
	}
	return { bytes: n * MiB, mib: n, source: 'RECYCLE_WASM_MIB' };
}

// Why a runtime is dropped after its request, or null to keep it: 'crashed' (php-wasm answered a bare
// 500; never reuse it), 'forced' (the spike-gated x-runtime-recycle: force), or 'memory' (the heap is OVER
// the line; PHP_RECYCLE=off turns only this one off). The order is the one index.js reported in
// x-runtime-recycled before this change.
export function recycleDecision({ crashed = false, forced = false, wasmBytes, lineBytes, recycleOff = false }) {
	if (crashed) return 'crashed';
	if (forced) return 'forced';
	if (!recycleOff && wasmBytes > lineBytes) return 'memory';
	return null;
}
