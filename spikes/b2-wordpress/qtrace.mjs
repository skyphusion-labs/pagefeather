// #296 step 3, measure first: where one request's queries go. Operator only (index.js turns it on for a request
// with the spike token and x-pf-qtrace: 1) and measure only. The SHAPE of a query keeps no literal, because a value
// can be row data (an email, an order key, a password hash); the summary names verbs, tables, callers and shapes.
// The caller comes from PHP (hyperdrive-db.php, only while the trace is on): "<area>:<file>::<function>", where
// area is plugin:<slug>, theme:<slug>, core, mu or dropin.

const TOP = 30;
const SHAPE_MAX = 200;

/** The query with every literal replaced by ?: strings (backslash and doubled-quote escapes), hex, numbers; IN lists
 * of literals collapse to IN (?+), so one shape covers every list length. Whitespace collapses. */
export function sqlShape(sql) {
	let out = '';
	const s = String(sql);
	for (let i = 0; i < s.length; ) {
		const c = s[i];
		if (c === "'" || c === '"') {
			let j = i + 1;
			while (j < s.length) {
				if (s[j] === '\\') { j += 2; continue; }
				if (s[j] === c) { if (s[j + 1] === c) { j += 2; continue; } break; }
				j++;
			}
			out += '?';
			i = j + 1;
			continue;
		}
		out += c;
		i++;
	}
	return out
		.replace(/(?<![A-Za-z0-9_$.?])0x[0-9A-Fa-f]+\b/g, '?')
		.replace(/(?<![A-Za-z0-9_$.?])\d+(?:\.\d+)?(?:[eE][-+]?\d+)?(?![A-Za-z0-9_$])/g, '?')
		.replace(/(^|[\s(,=<>])-\?/g, '$1?')
		.replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, 'IN (?+)')
		.replace(/\s+/g, ' ')
		.trim();
}

export function sqlVerb(sql) {
	const m = /^[\s(]*([A-Za-z]+)/.exec(String(sql));
	return m ? m[1].toUpperCase() : '?';
}

function tableOf(sql) {
	const m = /\b(?:FROM|INTO|UPDATE|JOIN)\s+`?([A-Za-z0-9_]+)`?/i.exec(sql);
	return m ? m[1].toLowerCase() : sqlVerb(sql).toLowerCase();
}

function areaOf(caller) {
	if (typeof caller !== 'string' || !caller) return '?';
	const p = caller.split(':');
	return p[0] === 'plugin' || p[0] === 'theme' ? p[0] + ':' + (p[1] || '?') : p[0];
}

function bump(map, k, ms) {
	const e = map[k] || (map[k] = { n: 0, ms: 0 });
	e.n++;
	e.ms += ms;
}

const top = (map, key, n = TOP) => Object.entries(map).sort((a, b) => b[1].n - a[1].n || b[1].ms - a[1].ms).slice(0, n).map(([k, v]) => ({ [key]: k, n: v.n, ms: v.ms }));

export function createTrace() {
	const byVerb = {}, byTable = {}, byArea = {}, byCaller = {}, byShape = {};
	const seen = new Set();
	const runs = [];
	let n = 0, ms = 0, last = null, runLen = 0;
	const closeRun = () => { if (runLen >= 2) runs.push({ shape: last, len: runLen }); };
	return {
		add(sql, qms, caller) {
			const shape = sqlShape(sql).slice(0, SHAPE_MAX);
			const t = Math.max(0, Number(qms) || 0);
			n++; ms += t;
			bump(byVerb, sqlVerb(sql), t);
			bump(byTable, tableOf(sql), t);
			bump(byArea, areaOf(caller), t);
			bump(byCaller, typeof caller === 'string' && caller ? caller.slice(0, 160) : '?', t);
			bump(byShape, shape, t);
			seen.add(String(sql));
			if (shape === last) runLen++;
			else { closeRun(); last = shape; runLen = 1; }
		},
		summary() {
			closeRun(); runLen = 0; // idempotent enough for one call per request
			const r = runs.slice().sort((a, b) => b.len - a.len);
			return {
				n, ms, byVerb, byTable, byArea,
				topCallers: top(byCaller, 'c'),
				topShapes: top(byShape, 'shape'),
				runs: { count: runs.length, saved: runs.reduce((a, x) => a + x.len - 1, 0), top: r.slice(0, 10) },
				dupes: { distinct: seen.size, extra: n - seen.size },
			};
		},
	};
}
