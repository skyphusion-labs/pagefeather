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

const ranked = (map) => Object.entries(map).sort((a, b) => b[1].n - a[1].n || b[1].ms - a[1].ms);
const top = (map, key, n = TOP) => ranked(map).slice(0, n).map(([k, v]) => ({ [key]: k, n: v.n, ms: v.ms }));
// #1233: what top() left out. A count-1 statement ranks last, so a fix that folds 342 deletes into ONE statement made that
// statement vanish from topShapes and topCallers (sb1120, #1219), and "not listed" read as "never ran". The cut says how
// many distinct entries exist and what the lists dropped, so a reader knows a list is partial.
function cut(map, n = TOP) {
	const all = ranked(map), rest = all.slice(n);
	return { distinct: all.length, cutN: rest.reduce((a, [, v]) => a + v.n, 0), cutMs: rest.reduce((a, [, v]) => a + v.ms, 0) };
}

export function createTrace() {
	const byVerb = {}, byTable = {}, byTableVerb = {}, byArea = {}, byCaller = {}, byShape = {};
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
			bump(byTableVerb, tableOf(sql) + ' ' + sqlVerb(sql), t); // #1233: complete, never cut (tables x verbs is small)
			bump(byArea, areaOf(caller), t);
			bump(byCaller, typeof caller === 'string' && caller ? caller.slice(0, 240) : '?', t); // #1090: room for "<- the asker"
			bump(byShape, shape, t);
			seen.add(String(sql));
			if (shape === last) runLen++;
			else { closeRun(); last = shape; runLen = 1; }
		},
		summary() {
			closeRun(); runLen = 0; // idempotent enough for one call per request
			const r = runs.slice().sort((a, b) => b.len - a.len);
			return {
				n, ms, byVerb, byTable, byTableVerb, byArea,
				topCallers: top(byCaller, 'c'),
				topShapes: top(byShape, 'shape'),
				callersCut: cut(byCaller),
				shapesCut: cut(byShape),
				runs: { count: runs.length, saved: runs.reduce((a, x) => a + x.len - 1, 0), top: r.slice(0, 10) },
				dupes: { distinct: seen.size, extra: n - seen.size },
			};
		},
	};
}
