// #1022 E2: a boot's phases for the perf line (bootPh), from boot()'s marks. A reading only. On Workers Date.now()
// moves only at I/O, so each phase is the wall time between I/O points, not CPU: a synchronous step (the spare's
// zero-fill) lands in the next phase that ends at I/O. marks: b0 (boot start), waitDone (after the reuse and gate
// waits), t0 (just before instantiation, after the take), wasm (instantiation, ms), site (ms after wasm), files (ms
// after wasm, cumulative over site and files), end (the return), reused (the boot took the spare). Missing marks give
// undefined, never a made-up 0.
const n = (v) => typeof v === 'number' && Number.isFinite(v);
export function bootPhases(m) {
	if (!m || ![m.b0, m.waitDone, m.t0, m.wasm, m.site, m.files, m.end].every(n)) return undefined;
	return {
		wait: m.waitDone - m.b0,
		prep: m.t0 - m.waitDone,
		wasm: m.wasm,
		site: m.site,
		files: m.files - m.site,
		init: m.end - m.t0 - m.wasm - m.files,
		total: m.end - m.b0,
		reused: m.reused ? 1 : 0,
		// #1022 E2 follow-up: init at its own I/O points (salts' digests, the self-check php.run where a boot's first
		// pack fetches happen, the rest), and the remote packs this boot fetched (remoteCounters at start and end).
		...([m.salted, m.check0, m.check1].every(n)
			? { initSplit: { salts: m.salted - m.t0 - m.wasm - m.files, check: m.check1 - m.check0, rest: m.end - m.salted - (m.check1 - m.check0) } }
			: {}),
		...(m.rc0 && m.rc1 ? { packs: packDelta(m.rc0, m.rc1) } : {}),
	};
}
function packDelta(a, b) {
	const d = (k) => (n(b[k]) && n(a[k]) ? b[k] - a[k] : 0);
	return { rfN: d('rfN'), rfKiB: Math.round(d('rfBytes') / 1024), rsN: d('rsN'), rsKiB: Math.round(d('rsBytes') / 1024) };
}
