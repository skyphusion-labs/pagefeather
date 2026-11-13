// PROBE ONLY (#391, deploy cap 2). Not for main. Why does a write that enters the object while
// renders are in flight die in a memory reset? Snapshots: the current runtime's WASM size, whether
// the runtime dropped at the last recycle is still alive (WeakRef), and the JS heap if the runtime
// exposes it. Writes store their snapshots (they survive a reset); GETs only update module state.
let droppedRef = null;
let droppedAt = 0;
let droppedMiB = 0;
let drops = 0;
let curRef = null;
const MiB = (b) => Math.round(b / 1048576);
function weak(o) {
	try { return new WeakRef(o); } catch { return 'na'; }
}
export function probeDrop(php, wasmBytes) {
	droppedRef = weak(php);
	droppedAt = Date.now();
	droppedMiB = MiB(wasmBytes);
	drops++;
}
export function probeCur(php) {
	curRef = weak(php);
}
export function snapshot(phase, extra, priv) {
	let cur = null;
	try {
		const p = curRef && curRef !== 'na' ? curRef.deref() : null;
		cur = p ? MiB(p[priv].HEAPU8.length) : null;
	} catch {}
	const alive = droppedRef === null ? null : droppedRef === 'na' ? 'na' : droppedRef.deref() !== undefined;
	let heap = null;
	try { heap = globalThis.performance && performance.memory ? MiB(performance.memory.usedJSHeapSize) : null; } catch {}
	return { phase, t: Date.now(), curWasmMiB: cur, droppedAlive: alive, droppedMiB, sinceDropMs: droppedAt ? Date.now() - droppedAt : null, drops, jsHeapMiB: heap, ...extra };
}
export const PROBE_KEY = 'probe391';
export async function probeStore(storage, rec) {
	const list = (await storage.get(PROBE_KEY)) || [];
	list.push(rec);
	await storage.put(PROBE_KEY, list.slice(-200));
}
