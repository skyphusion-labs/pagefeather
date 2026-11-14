// Size figures of an engine wasm (#582 S2), the ones the design compares: file bytes, code bytes (the
// code section), stored data bytes, the static data end (the highest end of an active data segment),
// exports, imports, and whether it is a dylink main module. Prints "@event wasm-stats {json}".
//   node engine/tools/wasm-stats.mjs <php.wasm> [label]
import { readFileSync } from 'node:fs';
const [f, label] = process.argv.slice(2);
if (!f) { console.error('usage: wasm-stats.mjs <php.wasm> [label]'); process.exit(2); }
const b = readFileSync(f); let i = 8;
if (b.readUInt32LE(0) !== 0x6d736100) { console.error('not a wasm file'); process.exit(2); }
const leb = () => { let r = 0, s = 0, x; do { x = b[i++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return r; };
const sleb = () => { let r = 0, s = 0, x; do { x = b[i++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); if (s < 32 && (x & 0x40)) r |= (~0 << s); return r; };
const o = { label: label || f, fileBytes: b.length, codeBytes: 0, dataStoredBytes: 0, dataEnd: 0, dataSegments: 0, exports: 0, imports: 0, dylink: false, initialPages: null };
while (i < b.length) {
	const id = b[i++]; const size = leb(); const end = i + size;
	if (id === 0) { const n = leb(); if (b.toString('utf8', i, i + n) === 'dylink.0') o.dylink = true; }
	else if (id === 2) o.imports = leb();
	else if (id === 5) { leb(); i++; o.initialPages = leb(); }
	else if (id === 7) o.exports = leb();
	else if (id === 10) o.codeBytes = size;
	else if (id === 11) {
		const n = leb(); o.dataSegments = n;
		for (let k = 0; k < n; k++) {
			const fl = leb(); let off = null;
			if (fl === 0 || fl === 2) { if (fl === 2) leb(); const op = b[i++]; if (op === 0x41) off = sleb(); while (b[i] !== 0x0b) i++; i++; }
			const sz = leb(); i += sz; o.dataStoredBytes += sz;
			if (typeof off === 'number') o.dataEnd = Math.max(o.dataEnd, off + sz);
		}
	}
	i = end;
}
const MiB = (x) => +(x / 1048576).toFixed(2);
o.MiB = { file: MiB(o.fileBytes), code: MiB(o.codeBytes), dataStored: MiB(o.dataStoredBytes), dataEnd: MiB(o.dataEnd) };
console.log('@event wasm-stats ' + JSON.stringify(o));
