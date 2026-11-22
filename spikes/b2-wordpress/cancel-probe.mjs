// #1359, measure first: does a client cancel stop a request's outstanding work, and does ctx.waitUntil keep it alive?
// On cf759hl (#1277 arm (b)), every stuck PHP lock head began with a client-CANCELED invocation and made no progress
// again. Cloudflare's docs say a disconnect cancels the request's outstanding work unless ctx.waitUntil holds it. This
// operator-only route measures it on the real platform: it awaits a timer, or a database SLEEP on the one-shot
// connection (an I/O await, as the stuck heads had), and logs each phase. hold=request: the request alone holds the
// await. hold=waituntil: ctx.waitUntil holds it too. A client that hangs up after 1 s, then the log, shows which fired.
// Off by default: only with CANCEL_PROBE=on AND a valid spike token.
export const CANCEL_PROBE_PATH = '/_cancel-probe';

export function cancelProbeAllowed(env, spikeOk) {
	return Boolean(spikeOk) && !!env && env.CANCEL_PROBE === 'on';
}

/** The await in ms: 1 s to 20 s, 5 s by default. */
export function probeMs(raw) {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0 || String(raw).trim() === '') return 5000;
	return Math.min(20000, Math.max(1000, Math.round(n)));
}

export async function cancelProbe(url, ctx, { log = (o) => console.log(JSON.stringify(o)), dbOneShot = null, dbRun = null, iso = null, withLock = null } = {}) {
	const id = String(url.searchParams.get('id') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'none';
	// rundb (the #1363 live check only): SELECT SLEEP through mysqlQuery, the run path PHP uses, on a run connection.
	const k = url.searchParams.get('kind');
	const kind = k === 'db' || k === 'rundb' ? k : 'timer';
	// lock (the #1363 recovery check): the await runs inside the isolate's PHP lock (withPhp), so a second probe on the same
	// isolate shows by its 'locked' time when the first one let the lock go.
	const hv = url.searchParams.get('hold');
	const hold = hv === 'waituntil' || hv === 'lock' ? hv : 'request';
	const ms = probeMs(url.searchParams.get('ms'));
	const t0 = Date.now();
	const line = (phase, extra = {}) => log({ m: 'cancel-probe', phase, id, kind, hold, ms, iso, at: Date.now(), atMs: Date.now() - t0, ...extra });
	line('start');
	const body = async () => {
		if (hold === 'lock') line('locked');
		let err = null;
		try {
			if (kind === 'rundb') {
				if (!dbRun) throw new Error('no database handler');
				const r = await dbRun(`SELECT SLEEP(${Math.round(ms / 1000)})`);
				if (r && r.ok === false) err = String(r.error || 'db error').slice(0, 160);
			} else if (kind === 'db') {
				if (!dbOneShot) throw new Error('no database handler');
				const r = await dbOneShot(`SELECT SLEEP(${Math.round(ms / 1000)})`);
				if (r && r.ok === false) err = String(r.error || 'db error').slice(0, 120);
			} else {
				await new Promise((resolve) => setTimeout(resolve, ms));
			}
		} catch (e) {
			err = String((e && e.message) || e).slice(0, 120);
		}
		line('fired', err ? { error: err } : {});
	};
	const work = hold === 'lock' && withLock ? withLock(body) : body();
	if (hold === 'waituntil' && ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
	await work;
	line('answered');
	return Response.json({ id, kind, hold, ms }, { headers: { 'cache-control': 'no-store' } });
}
