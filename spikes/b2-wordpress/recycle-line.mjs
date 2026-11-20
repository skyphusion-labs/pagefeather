// The PHP runtime recycle decision (#598), out of index.js so it is testable (tests/recycle-line.test.mjs).
//
// After each request, index.js drops the runtime when its WebAssembly memory passed the recycle line, so the
// next request boots a fresh one. A dropped memory is collected late (about 120 s on pf571r), and a DO keeps
// its isolate unless the platform replaces it. When the heap ends between our line and the platform's
// replacement point, the dropped memory stays and the next boot stacks a second one: pf582t (the lean engine,
// #582) ended editor pages at 109 to 114 MiB and lost 20 of 70 to memory resets that way.
//
// RECYCLE_WASM_MIB moves the line: an integer from 64 to 240 (MiB). Unset or empty keeps the ENGINE's default
// (#771: index.js passes ENGINE_RECYCLE_MIB from vendor/engine.mjs, 140 on lean and 100 on npm, as the #598 and
// #724 measurements set them; RECYCLE_DEFAULT_MIB when none is passed). A bad value keeps the default and says why
// (refused), so a typo never turns the recycle off or onto every request.
export const RECYCLE_DEFAULT_MIB = 100;
const MiB = 1048576;

export function recycleLine(env, def = RECYCLE_DEFAULT_MIB) {
	const d = Number.isInteger(def) && def >= 64 && def <= 240 ? def : RECYCLE_DEFAULT_MIB;
	const v = env ? env.RECYCLE_WASM_MIB : undefined;
	if (v === undefined || v === null || v === '') return { bytes: d * MiB, mib: d, source: 'default' };
	const s = String(v);
	const n = /^[0-9]{2,3}$/.test(s) ? Number(s) : NaN;
	if (!(n >= 64 && n <= 240)) {
		return { bytes: d * MiB, mib: d, source: 'default', refused: 'RECYCLE_WASM_MIB must be an integer from 64 to 240, not ' + JSON.stringify(s) };
	}
	return { bytes: n * MiB, mib: n, source: 'RECYCLE_WASM_MIB' };
}

// Why a runtime is dropped after its request, or null to keep it: 'crashed' (php-wasm answered a bare
// 500; never reuse it), 'forced' (the spike-gated x-runtime-recycle: force), or 'memory' (the heap is OVER
// the line; PHP_RECYCLE=off turns only this one off). The order is the one index.js reported in
// x-runtime-recycled before this change.
// bootBytes (#603 A): the memory's size when THIS runtime booted. A runtime that booted on a reused memory inherits
// its old size (wasm memory never shrinks), so a recycle for memory needs this runtime to have GROWN it past the
// line; an inherited size alone would recycle every request, forever. Without reuse a runtime boots at the 24 MiB
// start, so the rule is today's.
// ocBytes (#1008): the JS object cache's bytes. It and the wasm heap sit under the one isolate cap, so the line is
// compared with their sum. A missing or bad value counts as 0 (today's rule), never NaN, which would stop every
// recycle. The growth test stays on the wasm heap alone: a cache never recycles a runtime that grew nothing.
export function recycleDecision({ crashed = false, forced = false, wasmBytes, ocBytes = 0, lineBytes, bootBytes = 0, recycleOff = false }) {
	if (crashed) return 'crashed';
	if (forced) return 'forced';
	const oc = Number.isFinite(ocBytes) && ocBytes > 0 ? ocBytes : 0;
	if (!recycleOff && wasmBytes + oc > lineBytes && wasmBytes > bootBytes) return 'memory';
	return null;
}
