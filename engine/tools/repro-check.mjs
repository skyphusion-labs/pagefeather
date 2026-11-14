// The S1 reproduction standard (#582), as a check: a pinned build (ENGINE_PIN_ENV=1) equals the
// shipped wasm except the shipped binary's SECOND compile time. The shipped wasm embeds two __TIME__
// values ("09:42:29" and "09:42:58", from two compile units); one SOURCE_DATE_EPOCH gives both units
// "09:42:29", the linker merges the two equal strings, and every later address moves down. So:
//   1. the printable strings (6 or more bytes) differ ONLY by the loss of "09:42:58";
//   2. only the global, code and data sections differ;
//   3. every differing byte in global and code is an address moved down by the merged string's 9
//      bytes or 16 after alignment, as LEB128 shows it: 9, 16, a carry of 1, or those plus 128,
//      EXCEPT exactly the measured residue (2026-11-14, two pinned CI builds): 0 bytes in global and
//      3 in code. Those 3 are one constant moved by 8 (aligned) and one i32.const moved by 1538.
//      Inference, not verified: string-pool merging lays out the merged strings unevenly. The
//      count is pinned EXACTLY, so a change in either direction fails.
// Exit 0 if the standard holds, 1 if not (naming the rule), 2 on bad input.
//   node engine/tools/repro-check.mjs <shipped.wasm> <built.wasm>
import { readFileSync } from 'node:fs';
const [fa, fb] = process.argv.slice(2);
if (!fa || !fb) { console.error('usage: repro-check.mjs <shipped.wasm> <built.wasm>'); process.exit(2); }
const a = readFileSync(fa), b = readFileSync(fb);
function sections(buf) {
	if (buf.readUInt32LE(0) !== 0x6d736100) { console.error('not a wasm file'); process.exit(2); }
	const out = new Map(); let i = 8;
	while (i < buf.length) {
		const id = buf[i++]; let r = 0, s = 0, x;
		do { x = buf[i++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
		if (id !== 0) out.set(id, { start: i, size: r });
		i += r;
	}
	return out;
}
function strings(buf) {
	const out = []; let run = [];
	for (const x of buf) {
		if (x >= 0x20 && x < 0x7f) run.push(x);
		else { if (run.length >= 6) out.push(Buffer.from(run).toString('latin1')); run = []; }
	}
	if (run.length >= 6) out.push(Buffer.from(run).toString('latin1'));
	return out;
}
const fails = [];
// 1. strings: a multiset difference.
const count = (l) => l.reduce((m, s) => m.set(s, (m.get(s) || 0) + 1), new Map());
const ca = count(strings(a)), cb = count(strings(b));
const lost = [], gained = [];
for (const [s, n] of ca) for (let k = 0; k < n - (cb.get(s) || 0); k++) lost.push(s);
for (const [s, n] of cb) for (let k = 0; k < n - (ca.get(s) || 0); k++) gained.push(s);
if (!(lost.length === 1 && lost[0] === '09:42:58' && gained.length === 0)) fails.push('strings: lost ' + JSON.stringify(lost.slice(0, 5)) + ', gained ' + JSON.stringify(gained.slice(0, 5)));
// 2. sections.
const names = { 1: 'type', 2: 'import', 3: 'function', 4: 'table', 5: 'memory', 6: 'global', 7: 'export', 9: 'element', 10: 'code', 11: 'data', 12: 'datacount', 13: 'tag' };
const sa = sections(a), sb = sections(b);
const differing = [];
for (const id of new Set([...sa.keys(), ...sb.keys()])) {
	const x = sa.get(id), y = sb.get(id);
	if (!x || !y || x.size !== y.size || !a.subarray(x.start, x.start + x.size).equals(b.subarray(y.start, y.start + y.size))) differing.push(names[id] || String(id));
}
const allowed = new Set(['global', 'code', 'data']);
if (differing.some((s) => !allowed.has(s))) fails.push('sections: ' + differing.join(','));
// 3. the byte deltas in global and code.
const ok = new Set([9, 16, 1, 9 + 128, 16 + 128, 1 + 128]);
const census = {};
for (const id of [6, 10]) {
	const x = sa.get(id), y = sb.get(id);
	if (!x || !y || x.size !== y.size) { fails.push(names[id] + ': size differs'); continue; }
	let bad = 0, diff = 0;
	for (let k = 0; k < x.size; k++) {
		const p = a[x.start + k], q = b[y.start + k];
		if (p !== q) { diff++; if (!ok.has((p - q + 256) % 256)) bad++; }
	}
	census[names[id]] = { differing: diff, outsideShift: bad };
	const residue = { global: 0, code: 3 }[names[id]];
	if (bad !== residue) fails.push(names[id] + ': ' + bad + ' differing bytes are not the address shift (pinned residue ' + residue + ')');
}
console.log('@event repro-check ' + JSON.stringify({ holds: fails.length === 0, lostStrings: lost.length, gainedStrings: gained.length, sectionsDiffering: differing, census, fails }));
process.exit(fails.length ? 1 : 0);
