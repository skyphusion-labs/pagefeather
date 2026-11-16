// #598 part 2: never boot a second PHP runtime beside a retired one that is still resident. A dropped runtime's
// WebAssembly.Memory stays allocated until V8 collects it, and a new boot beside it took the object over its memory
// limit: exceededMemory, a lost write (#598 issuecomment of 16:54Z, the first login after a fixture load). Behind
// BOOT_GATE=on, default off (the lead's ruling: the default comes from the live measurement).
//
// The primary fix is memory-reuse.mjs (PHP_MEMORY_REUSE=on): the next boot takes the retired memory, so nothing
// stacks. This gate is the guard for the case with NO spare (a runtime released with a call in flight, or the flag
// off). It NEVER WAITS: on local workerd the retired memory was not collected within about 660 s under one request
// a second (#598, 2026-11-15), so a gate that waits on GC is a permanent 503. It decides once, at boot.
//
// The gate is SIZE-AWARE. It refuses a boot only when the retired memory still alive plus what the new runtime is
// expected to reach would pass the budget:
//   retiredMiB + expectedMiB > budgetMiB
// expectedMiB is the larger of the start size (the engine's initial pages) and the high-water of an admin request.
// Always admin, whatever request boots: the runtime then serves every later request, and the next admin screen
// grows it to that size (#705 review, finding 5).
// The spare is not retired memory: it is the new runtime's, and the new runtime is at least its size (wasm memory
// never shrinks), so with a spare the expected size is max(expectedMiB, spareMiB):
//   retiredMiB + max(expectedMiB, spareMiB) > budgetMiB   refuses
// except with NO other retired memory: a spare alone never refuses (refusing frees nothing; #705 review, finding
// 4), and a spare beside other retired memory is sized like any boot (#705 second review, finding 4).
// BOUNDED (#705 second review, finding 1): a retired memory that never becomes a spare (a release with a call in
// flight, a stale lock, an orphan boot) is never collected on any useful timescale, so a refusal could last
// forever. Once refusals have gone on for BOOT_GATE_MAX_REFUSE_S without a boot, the next boot goes anyway: it
// is today's behaviour, and the platform's memory reset of the isolate is what then frees what GC does not. The
// gate buys time for GC and for reuse; it is never the reason an isolate answers 503 for good.
//
// Settings (each a whole number; a bad value keeps the default and is reported in `refused`):
//   BOOT_GATE              on | off (default off)
//   BOOT_GATE_BUDGET_MIB   the memory a boot may assume for retired + new (default 120: the 128 MiB isolate less a
//                          margin for the JS heap, the MEMFS and the caches)
//   BOOT_GATE_ADMIN_MIB    the high-water of an admin request (default 112: editor screens reach 109 to 121 MiB on the
//                          npm engine, #598 issuecomment-6887747003)
//   BOOT_GATE_START_MIB    the engine's initial memory (default 24: 384 pages, prepare.sh)
//   BOOT_GATE_MAX_REFUSE_S the longest a streak of refusals lasts before a boot goes anyway (default 60, at most 600)

export const GATE_DEFAULTS = Object.freeze({ budgetMiB: 120, adminMiB: 112, startMiB: 24, maxRefuseS: 60 });

const KEYS = [['budgetMiB', 'BOOT_GATE_BUDGET_MIB'], ['adminMiB', 'BOOT_GATE_ADMIN_MIB'],
	['startMiB', 'BOOT_GATE_START_MIB'], ['maxRefuseS', 'BOOT_GATE_MAX_REFUSE_S']];

/** The gate's settings from the Worker env. */
export function gateSettings(env) {
	const e = env || {};
	const s = { on: String(e.BOOT_GATE || '').trim().toLowerCase() === 'on', ...GATE_DEFAULTS, refused: [] };
	for (const [k, name] of KEYS) {
		if (e[name] === undefined || e[name] === '') continue;
		const v = String(e[name]).trim();
		const max = k === 'maxRefuseS' ? 600 : 1e6;
		if (/^[0-9]+$/.test(v) && Number(v) > 0 && Number(v) <= max) s[k] = Number(v);
		else s.refused.push(name);
	}
	return s;
}

/** What a new runtime is expected to reach, in MiB: the admin high-water, never below the start size. */
export function expectedMiB(s) {
	return Math.max(s.startMiB, s.adminMiB);
}

/**
 * The decision, once, with no wait. retiredMiB: the retired memory still alive, the spare apart; spareMiB: the size
 * of the spare this boot reuses (0 when none); refusingForMs: how long the current streak of refusals has lasted.
 */
export function decide(retiredMiB, s, spareMiB = 0, refusingForMs = 0) {
	const r = Math.max(0, Number(retiredMiB) || 0);
	const spare = Math.max(0, Number(spareMiB) || 0);
	const expect = expectedMiB(s);
	const fits = r === 0 || r + Math.max(expect, spare) <= s.budgetMiB;
	const expired = !fits && Number(refusingForMs) >= s.maxRefuseS * 1000;
	return { boot: fits || expired, ...(expired ? { expired: true } : {}), retiredMiB: r, spareMiB: spare, expectMiB: expect, budgetMiB: s.budgetMiB };
}

/** The streak of refusals: it starts at the first refusal after a boot, and a boot ends it. */
export function createGateClock(now = () => Date.now()) {
	let since = null;
	return {
		refusingForMs() { return since === null ? 0 : now() - since; },
		refused() { if (since === null) since = now(); },
		booted() { since = null; },
	};
}

/** Thrown by boot() when the gate refuses; the request path answers bootRefusedResponse(). */
export class BootRefused extends Error {
	constructor(d) {
		super('boot refused: ' + d.retiredMiB + ' MiB of a retired runtime still resident');
		this.name = 'BootRefused';
		this.bootRefused = d;
	}
}

/** fn's answer, or the known 503 when it threw a refused boot (any route, the object and the Worker alike). */
export async function withBootRefusal(fn) {
	try {
		return await fn();
	} catch (e) {
		if (e && e.bootRefused) return bootRefusedResponse(e.bootRefused);
		throw e;
	}
}

/** The fast, known answer: nothing ran, so a POST is not half applied; the client may retry. */
export function bootRefusedResponse(d) {
	return new Response('busy: the previous PHP runtime is still being freed; retry in a few seconds\n', {
		status: 503,
		headers: {
			'retry-after': '5',
			'x-runtime-wait': 'retired-resident',
			'x-runtime-wait-mib': String(d.retiredMiB),
			// the decision's serial: a refusal answered again from a cached rejected boot would repeat it (#705)
			...(d.decision ? { 'x-runtime-wait-decision': String(d.decision) } : {}),
			'cache-control': 'no-store',
			'content-type': 'text/plain; charset=utf-8',
		},
	});
}
