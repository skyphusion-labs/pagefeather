// #1253: the plain files under a MEMFS directory, for opCompiled on the perf line. In the OPcache file-cache directory,
// a plain file (a data `contents`, no getter) is one PHP WROTE: a script compiled from source that the packs lack.
// Packed scripts are lazy or remote nodes (a `contents` getter); this never reads one, so it inflates nothing. It walks
// node.contents of each directory (never lookup), so it creates no node.
const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000;
export function plainFileCount(root) {
	let n = 0;
	const seen = new Set();
	const stack = root ? [root] : [];
	while (stack.length) {
		const node = stack.pop();
		if (!node || typeof node !== 'object' || seen.has(node)) continue;
		seen.add(node);
		const kind = (node.mode || 0) & S_IFMT;
		if (kind === S_IFDIR) {
			const c = node.contents;
			if (c && typeof c === 'object' && !ArrayBuffer.isView(c)) for (const k of Object.keys(c)) stack.push(c[k]);
		} else if (kind === S_IFREG) {
			const d = Object.getOwnPropertyDescriptor(node, 'contents');
			if (d && !d.get) n++;
		}
	}
	return n;
}
