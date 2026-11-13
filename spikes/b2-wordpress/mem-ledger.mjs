// The isolate memory ledger (#394, design: issue comment 6866536182). Workers has no reading of an
// isolate's memory (process.memoryUsage() is a stub: every field 0, probe p394-mem, 2026-11-13), and
// post-new dies at a SQL write with WASM at 89 MiB, so the memory that takes the isolate over its
// limit is OUTSIDE PHP's heap. This adds up what index.js holds and can see:
//   - runtimes: every PHP runtime booted in this isolate, through a WeakRef, so a RETIRED runtime
//     (recycled, released, or just unreferenced) that is still alive is counted with its WASM bytes.
//     A FinalizationRegistry counts the ones collected (probe p394-fr: it fires on Cloudflare).
//   - memfs: the bytes in PHP's in-memory filesystem (JS typed arrays), by top directory. A lazy
//     bundle file (a getter on `contents`) is never read here: reading it would inflate it.
//   - sql: the bytes of the SQL replies handed to PHP in this request, and the largest one.
//   - the lazy inflate cache and the object cache (index.js passes their counters).
// Operator only and off by default: index.js calls it only when MEM_LEDGER=on or a request with a
// valid spike token sends x-mem-ledger: 1. The MEMFS walk costs CPU, so it runs only at a snapshot.

const MIB = 1048576;
const mib = (n) => Math.round((n / MIB) * 10) / 10;

export function createLedger() {
	const runtimes = []; // { serial, ref }
	let collected = 0;
	const reg = typeof FinalizationRegistry === 'function' ? new FinalizationRegistry(() => { collected++; }) : null;
	return {
		/** A runtime was booted. heapOf(php) reads its WASM bytes. */
		register(php, serial) {
			if (typeof WeakRef !== 'function' || !php) return;
			runtimes.push({ serial, ref: new WeakRef(php) });
			if (reg) reg.register(php, serial);
			if (runtimes.length > 64) runtimes.splice(0, runtimes.length - 64); // bounded; old entries are long gone
		},
		/** The runtimes this isolate booted that are still alive, the current one apart. */
		runtimes(currentSerial, heapOf) {
			let live = 0, retired = 0, retiredBytes = 0, currentBytes = 0;
			for (const r of runtimes) {
				const php = r.ref.deref();
				if (!php) continue;
				live++;
				let b = 0;
				try { b = heapOf(php) || 0; } catch { b = 0; }
				if (r.serial === currentSerial) currentBytes = b;
				else { retired++; retiredBytes += b; }
			}
			return { booted: runtimes.length, live, collected, finalizer: !!reg, currentMiB: mib(currentBytes), retired, retiredMiB: mib(retiredBytes) };
		},
	};
}

/** Bytes in an Emscripten MEMFS tree, by top directory. Lazy contents (a getter) are skipped and counted. */
export function memfsBytes(FS, maxNodes = 200000) {
	const out = { total: 0, files: 0, lazySkipped: 0, nodes: 0, byTop: {}, truncated: false };
	if (!FS || !FS.root) return { totalMiB: 0, files: 0, lazySkipped: 0, nodes: 0, truncated: false, byTop: {} };
	const seen = new Set();
	const stack = [[FS.root, '']];
	while (stack.length) {
		const [node, top] = stack.pop();
		if (!node || seen.has(node)) continue;
		seen.add(node);
		if (++out.nodes > maxNodes) { out.truncated = true; break; }
		if (node.mounted && node.mounted.root && node.mounted.root !== node) stack.push([node.mounted.root, top]);
		const isDir = typeof FS.isDir === 'function' ? FS.isDir(node.mode) : false;
		const d = Object.getOwnPropertyDescriptor(node, 'contents');
		if (isDir) {
			const kids = d && 'value' in d ? d.value : null;
			if (kids && typeof kids === 'object') for (const name of Object.keys(kids)) stack.push([kids[name], top || '/' + name]);
			continue;
		}
		if (d && typeof d.get === 'function') { out.lazySkipped++; continue; } // a lazy bundle file: never inflate it here
		const c = d && 'value' in d ? d.value : null;
		const n = c ? (typeof c.byteLength === 'number' ? c.byteLength : typeof c.length === 'number' ? c.length : 0) : 0;
		if (!n) continue;
		out.files++;
		out.total += n;
		const k = top || '/';
		out.byTop[k] = (out.byTop[k] || 0) + n;
	}
	const byTop = {};
	for (const [k, v] of Object.entries(out.byTop).sort((a, b) => b[1] - a[1]).slice(0, 8)) byTop[k] = mib(v);
	return { totalMiB: mib(out.total), files: out.files, lazySkipped: out.lazySkipped, nodes: out.nodes, truncated: out.truncated, byTop };
}

/** Per-request SQL reply bytes. */
export function createSqlMeter() {
	let n = 0, bytes = 0, max = 0;
	return {
		add(len) { n++; bytes += len; if (len > max) max = len; },
		reset() { n = 0; bytes = 0; max = 0; },
		read() { return { n, MiB: mib(bytes), maxKiB: Math.round(max / 1024) }; },
	};
}

/** Is the ledger on for this request? MEM_LEDGER=on, or the operator header with a valid spike token. */
export function ledgerOn(env, headerValue, operator) {
	if (env && env.MEM_LEDGER === 'on') return true;
	return !!operator && headerValue === '1';
}

export const LEDGER_MIB = mib;
