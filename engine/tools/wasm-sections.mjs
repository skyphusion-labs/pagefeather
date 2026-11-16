// The ONE reader of a wasm binary's sections for the JS side (#603, the #705 review's finding 9): the engine contract
// (tests/engine-contract.mjs), wasm-stats.mjs and the memory tests all parse through this. prepare.sh's transform is
// the one WRITER (Python, in prepare.sh); this reads what it wrote.
//   sections(bytes)          [{ id, start, end }] of each section's payload
//   importEntries(bytes)     [{ module, field, kind, limits }] (limits { flags, min, max } for a memory, else null)
//   memoryShape(bytes)       { defined, imported }: the memory the module defines, and the one it imports
//   linkShape(bytes)         { dylink, exports }: the dylink.0 custom section, and the export count
//   untransformMemory(bytes) the module as it was BEFORE prepare.sh's memory transform (for the mismatch tests)

const leb = (b, i) => { let r = 0, s = 0, x; do { x = b[i++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return [r, i]; };
const enc = (n) => { const o = []; do { const x = n & 0x7f; n = Math.floor(n / 128); o.push(x | (n ? 0x80 : 0)); } while (n); return Uint8Array.from(o); };
const utf8 = (b, i, n) => new TextDecoder().decode(b.subarray(i, i + n));
const bytesOf = (bytes) => (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

export function sections(bytes) {
	const b = bytesOf(bytes); const out = [];
	for (let i = 8; i < b.length;) { const id = b[i]; const [size, j] = leb(b, i + 1); out.push({ id, start: j, end: j + size }); i = j + size; }
	return out;
}
function limits(b, i) { const flags = b[i]; let [min, k] = leb(b, i + 1); let max = null; if (flags & 1) [max, k] = leb(b, k); return [{ flags, min, max }, k]; }
function entriesOf(b, sec) {
	let [n, k] = leb(b, sec.start); const out = [];
	for (; n > 0; n--) {
		const st = k; let l;
		[l, k] = leb(b, k); const module = utf8(b, k, l); k += l;
		[l, k] = leb(b, k); const field = utf8(b, k, l); k += l;
		const kind = b[k++]; let lim = null;
		if (kind === 0) k = leb(b, k)[1];
		else if (kind === 1) k = limits(b, k + 1)[1];
		else if (kind === 2) [lim, k] = limits(b, k);
		else if (kind === 3) k += 2;
		else if (kind === 4) k = leb(b, k + 1)[1];
		else throw new Error('import kind ' + kind);
		out.push({ module, field, kind, limits: lim, start: st, end: k });
	}
	return out;
}
export function importEntries(bytes) {
	const b = bytesOf(bytes); const sec = sections(b).find((s) => s.id === 2);
	return sec ? entriesOf(b, sec).map(({ module, field, kind, limits: l }) => ({ module, field, kind, limits: l })) : [];
}
export function memoryShape(bytes) {
	const b = bytesOf(bytes); const out = { defined: null, imported: null };
	for (const s of sections(b)) {
		if (s.id === 5) { const [l] = limits(b, leb(b, s.start)[1]); out.defined = { min: l.min, max: l.max }; }
		if (s.id === 2) for (const e of entriesOf(b, s)) if (e.kind === 2) out.imported = { module: e.module, field: e.field, min: e.limits.min, max: e.limits.max };
	}
	return out;
}
export function linkShape(bytes) {
	const b = bytesOf(bytes); let dylink = false, exports = null;
	for (const s of sections(b)) {
		if (s.id === 0) { const [n, k] = leb(b, s.start); if (utf8(b, k, n) === 'dylink.0') dylink = true; }
		if (s.id === 7) exports = leb(b, s.start)[0];
	}
	return { dylink, exports };
}
// The module before the memory transform: its env.memory import (the last import, as prepare.sh appends it) removed,
// and a memory section with the SAME limits put back in its place in the section order (after the table section).
export function untransformMemory(bytes) {
	const b = bytesOf(bytes); const secs = sections(b);
	const imp = secs.find((s) => s.id === 2); if (!imp) throw new Error('no import section');
	const entries = entriesOf(b, imp); const last = entries[entries.length - 1];
	if (secs.some((s) => s.id === 5)) throw new Error('already defines a memory');
	if (!last || last.kind !== 2 || last.module !== 'env' || last.field !== 'memory') throw new Error('the last import is not the transform env.memory');
	const { min, max } = last.limits;
	const parts = [b.subarray(0, 8)]; let lastPre = -1;
	secs.forEach((s, k) => { if (s.id >= 1 && s.id <= 4) lastPre = k; });
	secs.forEach((s, k) => {
		let payload = b.subarray(s.start, s.end);
		if (s.id === 2) payload = concat([enc(entries.length - 1), b.subarray(entries[0].start, last.start)]);
		parts.push(Uint8Array.of(s.id), enc(payload.length), payload);
		if (k === lastPre) { const m = concat([enc(1), Uint8Array.of(max === null ? 0 : 1), enc(min), ...(max === null ? [] : [enc(max)])]); parts.push(Uint8Array.of(5), enc(m.length), m); }
	});
	return Buffer.from(concat(parts));
}
function concat(arr) { const n = arr.reduce((a, x) => a + x.length, 0); const o = new Uint8Array(n); let i = 0; for (const x of arr) { o.set(x, i); i += x.length; } return o; }
