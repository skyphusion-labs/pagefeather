// The per-request perf line for approach A (#1078). b-dosql logs m: perf from inside the object (index.js, ctx.inObject);
// approach A runs PHP in the Worker, so it logged no per-request timing and a tail could not time a real suite request.
// This is the same line for A: the wall time, the boot (and its wait), PHP time, the query count and their total
// round trip (on A every MySQL query through Hyperdrive is one bridge call), the per-query average, the isolate and
// the runtime. Numbers, ids and the PATH only: never the query string, which on a store carries order keys and logins.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
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
		phpMs: num(f.phpMs),
		dbN,
		dbMs,
		dbAvgMs: dbN > 0 && dbMs !== undefined ? Math.round((dbMs / dbN) * 10) / 10 : undefined,
		wallMs: num(f.wallMs),
		wasm1MiB: num(f.wasm1MiB),
		recycled: f.recycled || undefined,
		// #1078 round 2: what PHP waited on besides MySQL, and whether OPcache served (spike token + x-perf-opcache: 1).
		opHits: num(f.opHits),
		opMisses: num(f.opMisses),
		opCached: num(f.opCached),
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
		l2Neg: num(f.l2Neg), // #1078: misses answered by the negative L1, no KV read
		// #1078 round 2: single-key get() reads (one bridge call each, sequential) against get_multiple batches (parallel).
		l2SingleN: num(f.l2SingleN),
		l2SingleMs: num(f.l2SingleMs),
		l2BatchN: num(f.l2BatchN),
		l2BatchMs: num(f.l2BatchMs),
		l2Batches: num(f.l2Batches),
	};
	for (const k of Object.keys(line)) if (line[k] === undefined) delete line[k];
	return line;
}
