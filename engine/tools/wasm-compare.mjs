// Compare two wasm files (#582 S1): equal bytes, or WHERE they differ. Prints one line
// "@event wasm-compare {json}" and a per-section table. Exit 0 if equal, 1 if not, 2 on bad input.
//   node engine/tools/wasm-compare.mjs <a.wasm> <b.wasm>
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) { console.error('usage: wasm-compare.mjs <a.wasm> <b.wasm>'); process.exit(2); }
const sha = (b) => createHash('sha256').update(b).digest('hex');
const ids = { 0: 'custom', 1: 'type', 2: 'import', 3: 'function', 4: 'table', 5: 'memory', 6: 'global', 7: 'export', 8: 'start', 9: 'element', 10: 'code', 11: 'data', 12: 'datacount', 13: 'tag' };
function sections(b) {
	if (b.readUInt32LE(0) !== 0x6d736100) { console.error('not a wasm file'); process.exit(2); }
	const out = []; let i = 8;
	const leb = () => { let r = 0, s = 0, x; do { x = b[i++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return r; };
	while (i < b.length) {
		const start = i; const id = b[i++]; const size = leb(); const body = i;
		let name = ids[id] || String(id);
		if (id === 0) { const n = leb(); name = 'custom:' + b.toString('utf8', i, i + n); }
		out.push({ name, start, size, sha: sha(b.subarray(body, body + size)) });
		i = body + size;
	}
	return out;
}
const a = readFileSync(fa), b = readFileSync(fb);
let first = -1;
for (let k = 0; k < Math.min(a.length, b.length); k++) if (a[k] !== b[k]) { first = k; break; }
if (first < 0 && a.length !== b.length) first = Math.min(a.length, b.length);
const sa = sections(a), sb = sections(b);
const rows = [];
for (let k = 0; k < Math.max(sa.length, sb.length); k++) {
	const x = sa[k], y = sb[k];
	rows.push({ section: (x || y).name, a: x ? x.size : null, b: y ? y.size : null, same: !!(x && y && x.name === y.name && x.sha === y.sha) });
}
const where = first < 0 ? null : (sa.find((s) => first >= s.start && first < s.start + 6 + s.size) || {}).name;
const r = { equal: first < 0, a: { bytes: a.length, sha256: sha(a) }, b: { bytes: b.length, sha256: sha(b) }, firstDiff: first < 0 ? null : first, firstDiffSection: where || null, sectionsDiffering: rows.filter((x) => !x.same).map((x) => x.section) };
console.log('@event wasm-compare ' + JSON.stringify(r));
for (const x of rows) console.log((x.same ? '  same ' : '  DIFF ') + x.section.padEnd(22) + String(x.a).padStart(10) + String(x.b).padStart(10));
process.exit(r.equal ? 0 : 1);
