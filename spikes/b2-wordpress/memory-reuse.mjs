// #598 / #603: reuse the retired runtime's WebAssembly.Memory for the next boot, so an isolate never holds two.
// A dropped runtime's memory stays allocated until V8 collects it, and that did not happen within about 660 s on
// local workerd (#598, 2026-11-15) while the next boot grew a second ~110 MiB memory beside it: exceededMemory and a
// lost write live. prepare.sh makes the engine IMPORT its memory (env.memory, the npm and the lean engine alike), so
// the loader can hand a boot this spare (Module.pagefeatherMemory) instead of a new one. The isolate then holds
// max(old, new), never old + new. Behind PHP_MEMORY_REUSE=on, default off.
//
// A memory becomes the spare ONLY when nothing of its old runtime can still touch it:
//   - it is offered from releaseRuntime, which the retirer calls only on a clean reap (no PHP run executing);
//   - the runtime has DRAINED (drainAndRetire): no promising call in flight (Module.pfInFlight === 0; JSPI
//     suspends only inside one, so no suspended stack is left), and one macrotask after that, so the settled
//     calls' JS continuations (stackRestore, UTF8ToString) have finished with the heap (#705 review, finding 1);
//   - only then is it retired (Module.pfDead): every door of the loader (each export wrapper, each promising
//     entry, callUserCallback: the timers and the sleep wake) refuses it EVERY new call from then on, and nothing
//     of it is in flight to finish (#705 review, finding 2);
//   - no runtime was instantiated since this one was DROPPED (index.js records the runtime serial at the drop;
//     a runtime with no drop recorded counts as superseded): a memory released after a newer runtime started
//     would be held BESIDE it for that runtime's whole life (#705 review, finding 1 of the first round);
//   - the runtime was booted with the loader's reuse guards (Module.pagefeatherReuse), so its calls were counted.
// Anything else is refused: the memory is left to GC, and the boot gate (boot-gate.mjs) guards the next boot.
// One spare at most: a newer offer replaces it, and the older one goes to GC. take() zeroes the whole memory
// before the boot (dlmalloc assumes sbrk memory is zeroed; the wasm data segments are written again at
// instantiation).

/**
 * The boot race test seam (#603 B; tests/boot-race-e2e.sh only): BOOT_TEST_DELAY_MS, 1 to 10000, makes a boot wait
 * that long after its own turn, and lets a spike request with x-pf-test-drop: 1 drop the runtime outside the PHP
 * lock, so a drop can land in the middle of a boot. Both emitters refuse it (deploy/lib/memory-reuse.sh): it never
 * reaches a site. 0 (off) for anything else.
 */
export function bootTestDelayMs(env) {
	const v = String((env && env.BOOT_TEST_DELAY_MS) || '').trim();
	return /^[0-9]{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 10000 ? Number(v) : 0;
}

/**
 * #603 (#705 review, findings 1 and 2): retire a runtime only once it has DRAINED, then refuse it everything.
 * M is the loader's Module of a reuse runtime (pfInFlight, pfOnIdle, pfDead). Each round waits for the in-flight
 * count to reach 0 (pfOnIdle, bounded by roundMs), then one macrotask (tick): the settled calls' JS continuations
 * (php-wasm's ccall stackRestore, UTF8ToString of the result) run in the microtasks after the wasm call settles,
 * and they still read this heap, so the memory is not handed on before they have run. If the count is still 0, it
 * sets pfDead: from then on every door of the loader refuses every new call, and nothing is in flight to finish.
 * A call that started during the drain is counted and waited for, up to rounds. Resolves 'drained', or 'no-drain'
 * (pfDead is set anyway; the memory is then never handed on).
 */
export async function drainAndRetire(M, { rounds = 20, roundMs = 50, tick = () => new Promise((ok) => setTimeout(ok, 0)) } = {}) {
	for (let i = 0; i < rounds; i++) {
		if ((M.pfInFlight | 0) > 0) {
			let timer;
			await Promise.race([
				new Promise((ok) => { M.pfOnIdle = () => { M.pfOnIdle = null; ok(); }; }),
				new Promise((ok) => { timer = setTimeout(ok, roundMs); }),
			]);
			clearTimeout(timer);
			M.pfOnIdle = null;
		}
		await tick();
		if ((M.pfInFlight | 0) === 0) {
			M.pfDead = true;
			return 'drained';
		}
	}
	M.pfDead = true;
	return 'no-drain';
}

/** PHP_MEMORY_REUSE=on (default off). */
import { LEDGER_MIB } from './mem-ledger.mjs';

/** #603 (C): how long a spare is kept with no boot (then it goes to GC; the alarm also drops it). */
export const SPARE_TTL_MS = 30000;

/**
 * #603 (C): does this module import its memory (env.memory, the prepare.sh transform)? Read from the module before
 * any instantiation. A module that defines its own memory (a build made before the transform) never gets reuse:
 * a spare handed to it would be held beside the memory it makes itself.
 */
export function moduleImportsMemory(module) {
	try {
		return WebAssembly.Module.imports(module).some((i) => i.module === 'env' && i.name === 'memory' && i.kind === 'memory');
	} catch {
		return false;
	}
}

export function reuseOn(env) {
	return String((env && env.PHP_MEMORY_REUSE) || '').trim().toLowerCase() === 'on';
}

export function createSpare({ ttlMs = SPARE_TTL_MS, now = () => Date.now() } = {}) {
	let spare = null;
	let keptAt = 0;
	let timer = null;
	const drop = () => {
		if (timer) clearTimeout(timer);
		timer = null;
		spare = null;
	};
	let pendingP = null;
	const counts = { kept: 0, inFlight: 0, current: 0, noGuards: 0, taken: 0, replaced: 0, expired: 0 };
	const expire = (t = now()) => {
		if (!spare || t - keptAt < ttlMs) return false;
		drop();
		counts.expired++;
		return true;
	};
	return {
		/**
		 * The retired runtime's memory, offered at release (the caller has set the loader's pfDead first). on: reuse
		 * is active; inFlight: the loader's pfInFlight; current: a runtime was instantiated since this one was
		 * dropped; guarded: the runtime was booted with the loader's reuse guards (only then is pfInFlight counted).
		 * Returns why it was or was not kept. A kept spare is dropped after ttlMs with no boot.
		 */
		offer(memory, { on, inFlight, current, guarded = true }) {
			if (!on) return 'off';
			if (!memory || !memory.buffer) return 'no-memory';
			if (!guarded) { counts.noGuards++; return 'no-guards'; }
			if (current) { counts.current++; return 'newer-runtime'; }
			if ((inFlight | 0) !== 0) { counts.inFlight++; return 'in-flight'; }
			if (spare && spare !== memory) counts.replaced++;
			drop();
			spare = memory;
			keptAt = now();
			timer = setTimeout(() => expire(), ttlMs + 1);
			if (timer && typeof timer.unref === 'function') timer.unref();
			counts.kept++;
			return 'kept';
		},
		/** The spare, zeroed, for the next boot (and forgotten here); null when none. */
		take() {
			if (expire()) return null;
			const m = spare;
			drop();
			if (!m) return null;
			new Uint8Array(m.buffer).fill(0);
			counts.taken++;
			return m;
		},
		/**
		 * An offer still waiting for its runtime's exit handlers (index.js: pfOnIdle). A boot waits for it, bounded:
		 * waitPending(ms) answers 'none', 'settled' or 'timeout', always clears its timer, and on a timeout DROPS the
		 * pending offer, so a promise that never settles costs one boot one bound, never every boot (#705 second
		 * review, finding 5). A late offer is then refused anyway (a newer runtime exists).
		 */
		setPending(p) {
			pendingP = p;
			p.then(() => { if (pendingP === p) pendingP = null; }, () => { if (pendingP === p) pendingP = null; });
		},
		get pending() {
			return pendingP !== null;
		},
		async waitPending(ms) {
			const p = pendingP;
			if (!p) return 'none';
			let timer;
			const r = await Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((ok) => { timer = setTimeout(() => ok('timeout'), ms); })]);
			clearTimeout(timer);
			if (r === 'timeout' && pendingP === p) pendingP = null;
			return r;
		},
		/** Drop a spare past its TTL now (the alarm calls this); true when one was dropped. */
		expire,
		get mib() {
			return spare ? LEDGER_MIB(spare.buffer.byteLength) : 0;
		},
		counts,
	};
}
