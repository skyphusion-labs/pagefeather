// #1022: the bytes the runtime's MEMFS file nodes hold on the JS side, for the perf line (fsKiB).
// The isolate budget (about 255 MiB, #394 floor probes) is shared by the wasm heap and every ArrayBuffer; at a
// memory death the wasm heap explains about half of it. This is one measured part of the rest.
// It changes nothing:
// - It walks node.contents of each directory (never lookup or readdir), so a lazy directory child that was never
//   looked up is not created.
// - A lazy file (index.js attachLazyContents) is read through its pfHeld(), which returns the inflated copy or null
//   and never inflates. A node with a contents getter and no pfHeld is skipped, never read.
// - Each ArrayBuffer counts once: a stored file is a view of the bundle zip, and arena entries share the arena.
// - The buffers in exclude (the bundle's own zips, a fixed cost measured in #394) are left out.
const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000;

export function memfsHeld(root, exclude = []) {
	const skip = new Set();
	for (const z of exclude) if (z && z.buffer) skip.add(z.buffer); else if (z instanceof ArrayBuffer) skip.add(z);
	const seen = new Set();
	const bufs = new Set();
	let bytes = 0, files = 0;
	const stack = root ? [root] : [];
	while (stack.length) {
		const node = stack.pop();
		if (!node || typeof node !== 'object' || seen.has(node)) continue;
		seen.add(node);
		if (node.mounted && node.mounted.root) stack.push(node.mounted.root);
		const kind = (node.mode || 0) & S_IFMT;
		if (kind === S_IFDIR) {
			const c = node.contents;
			if (c && typeof c === 'object' && !ArrayBuffer.isView(c)) for (const k of Object.keys(c)) stack.push(c[k]);
			continue;
		}
		if (kind !== S_IFREG) continue;
		let v;
		if (typeof node.pfHeld === 'function') v = node.pfHeld();
		else {
			const d = Object.getOwnPropertyDescriptor(node, 'contents');
			if (!d || d.get) continue; // a getter without pfHeld: reading it could inflate, so it is not read
			v = d.value;
		}
		if (!v) continue;
		if (ArrayBuffer.isView(v)) {
			if (skip.has(v.buffer)) continue;
			files++;
			if (!bufs.has(v.buffer)) { bufs.add(v.buffer); bytes += v.buffer.byteLength; }
		} else if (Array.isArray(v) && v.length) {
			files++; bytes += v.length * 8; // an old-style MEMFS array: 8 bytes a slot, an upper bound
		}
	}
	return { bytes, files, buffers: bufs.size };
}
