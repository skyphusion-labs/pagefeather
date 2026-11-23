// The per-request perf line for approach A (#1078). b-dosql logs m: perf from inside the object (index.js, ctx.inObject);
// approach A runs PHP in the Worker, so it logged no per-request timing and a tail could not time a real suite request.
// This is the same line for A: the wall time, the boot (and its wait), PHP time, the query count and their total
// round trip (on A every MySQL query through Hyperdrive is one bridge call), the per-query average, the isolate and
// the runtime. Numbers, ids and the PATH only: never the query string, which on a store carries order keys and logins.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
// #1402: the R2 and Images bridge ops one request ran. r2op (index.js) keeps a running {op: {n, ms}} per isolate in
// stats.r2; r2OpsSnapshot copies it at the request's start, and r2OpsDelta is what this request added (only the ops
// that ran). image/images are the sub-sizes through the Images binding (their ms is the batch wall: jobs run in parallel).
export function r2OpsSnapshot(r2) {
	const o = {};
	for (const [k, v] of Object.entries(r2 || {})) o[k] = { n: v.n, ms: v.ms };
	return o;
}
export function r2OpsDelta(now, start) {
	const o = {};
	for (const [k, v] of Object.entries(now || {})) {
		const s = (start && start[k]) || { n: 0, ms: 0 };
		const n = v.n - s.n;
		if (n > 0) o[k] = { n, ms: v.ms - s.ms };
	}
	return Object.keys(o).length ? o : undefined;
}
function r2Field(r) {
	if (!r || typeof r !== 'object') return undefined;
	const o = {};
	for (const [k, v] of Object.entries(r)) if (v && num(v.n) !== undefined && num(v.ms) !== undefined) o[k] = { n: v.n, ms: v.ms };
	return Object.keys(o).length ? o : undefined;
}
export function aPerfLine(f) {
	const path = typeof f.path === 'string' ? f.path.split('?')[0] : undefined;
	const dbN = num(f.dbN);
	const dbMs = num(f.dbMs);
	const line = {
		m: 'perf',
		tier: 'a',
		id: f.id || undefined,
		method: f.method || undefined,
		path,
		status: num(f.status),
		iso: f.iso || undefined,
		isoAgeS: num(f.isoAgeS),
		rt: num(f.rt),
		rtAgeS: num(f.rtAgeS),
		boot: f.boot ? 1 : 0,
		bootWaitMs: num(f.bootWaitMs),
		bootPh: f.bootPh && typeof f.bootPh === 'object' ? f.bootPh : undefined, // #1022 E2: the boot's phases (boot-phases.mjs)
		phpMs: num(f.phpMs),
		dbN,
		dbMs,
		dbAvgMs: dbN > 0 && dbMs !== undefined ? Math.round((dbMs / dbN) * 10) / 10 : undefined,
		wallMs: num(f.wallMs),
		lockWaitMs: num(f.lockWaitMs), // #1119: the PHP lock wait before this run (wallMs starts after it)
		dbConnN: num(f.dbConnN), // #1169: the MySQL connects this request opened, and their time (inside dbMs)
		dbConnMs: num(f.dbConnMs),
		wasm1MiB: num(f.wasm1MiB),
		recycled: f.recycled || undefined,
		// #1078 round 2: what PHP waited on besides MySQL, and whether OPcache served (spike token + x-perf-opcache: 1).
		opHits: num(f.opHits),
		opMisses: num(f.opMisses),
		opCached: num(f.opCached),
		opCompiled: num(f.opCompiled), // #1253: .bin files written this request = scripts compiled from source
		opFull: typeof f.opFull === 'boolean' ? f.opFull : undefined,
		rfN: num(f.rfN),
		rfKiB: num(f.rfKiB),
		rfMs: num(f.rfMs),
		rfFail: num(f.rfFail),
		rsN: num(f.rsN),
		rsKiB: num(f.rsKiB),
		rsMs: num(f.rsMs),
		rsFail: num(f.rsFail),
		httpN: num(f.httpN),
		httpMs: num(f.httpMs),
		inflates: num(f.inflates),
		inflateKiB: num(f.inflateKiB),
		// #1078 round 3: the object cache bridge, and its KV L2 reads on A (one OC_KV.get per key missing the isolate Map).
		ocCalls: num(f.ocCalls),
		ocHits: num(f.ocHits),
		l2N: num(f.l2N),
		l2Hits: num(f.l2Hits),
		l2Misses: num(f.l2Misses),
		l2Ms: num(f.l2Ms),
		r2: r2Field(f.r2), // #1402: {op: {n, ms}}, the R2 and Images bridge ops this request ran
	};
	for (const k of Object.keys(line)) if (line[k] === undefined) delete line[k];
	return line;
}
