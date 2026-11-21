// Approach A: Workers Cron Trigger ticks a named PhpRuntime (#855). Hyperdrive only; off unless
// A_CRON=on on the Worker. Does not run runCron in the front isolate (#714).

export const CRON_OBJECT_NAME = 'cron';
export const CRON_TICK_PATH = '/_cron-tick';
export const CRON_TICK_HEADER = 'x-pf-cron-tick';
// #1152: the tick carries the site Worker's build, so a cron object left on an older version after a deploy notices.
export const CRON_BUILD_HEADER = 'x-pf-build';
// #1152: the spike-gated readback of the Worker's build and the cron object's (deploy.sh warns when they differ).
export const CRON_BUILD_PATH = '/_cron-build';
// #1152 (the lead's guard): at most one version reset per object per 10 minutes. During a gradual or split deployment
// ticks come from both versions; without a bound the object would reset on every other tick.
export const VERSION_ABORT_GAP_MS = 10 * 60 * 1000;
/** #1152: should the cron object reset itself onto the tick's version? Only when both builds are known and differ, and
 * no reset happened in the last VERSION_ABORT_GAP_MS (lastAbortAt, stored, survives the reset). */
export function cronVersionAbort({ own, tick, lastAbortAt, now }) {
	if (typeof own !== 'string' || !own || typeof tick !== 'string' || !tick || own === tick) return false;
	if (Number(lastAbortAt) > 0 && now - Number(lastAbortAt) < VERSION_ABORT_GAP_MS) return false;
	return true;
}

/** True when this Worker is configured for the cron DO tick (not b-dosql PHP_IN_DO). */
export function approachACronEnabled(env) {
	if (!env || env.A_CRON !== 'on') return false;
	if (env.PHP_IN_DO === 'on') return false;
	return true;
}

/**
 * #1186: an approach A object on a cron-off build. On approach A a PhpRuntime is only the cron object or a pool object
 * (a pool request never arms the alarm), so with the cron off an alarm there has no work. Every DO tier renders
 * PHP_IN_DO=on (render-conf.sh, deploy/wfp, provision), where the alarm runs the site's cron and purges: never this.
 */
export function aCronObjectOff(env) {
	if (!env) return false;
	if (env.PHP_IN_DO === 'on' || env.DB_IN_DO === 'on') return false;
	return env.A_CRON !== 'on';
}

/** A POST the site Worker sends to the cron object (never a public route). */
export function cronTickRequest(origin, { PhpRuntime, objectName = CRON_OBJECT_NAME, build = null } = {}) {
	if (!PhpRuntime || typeof PhpRuntime.idFromName !== 'function') throw new Error('cron: no PHP_RUNTIME binding');
	const id = PhpRuntime.idFromName(objectName);
	const stub = PhpRuntime.get(id);
	const req = new Request(`https://do.internal${CRON_TICK_PATH}`, {
		method: 'POST',
		headers: { 'x-wp-public-origin': origin, [CRON_TICK_HEADER]: '1', ...(typeof build === 'string' && build ? { [CRON_BUILD_HEADER]: build } : {}) },
	});
	return { stub, req };
}

/**
 * scheduled() handler: waitUntil a tick on the cron PhpRuntime. Caller passes siteOrigin(env, url)
 * because index.js owns that helper.
 */
export async function approachACronScheduled(event, env, ctx, siteOrigin, build = null) {
	if (!approachACronEnabled(env) || !env.PHP_RUNTIME) return;
	const origin = siteOrigin(env, new URL(String(env.SITE_ORIGIN || 'https://localhost/')));
	const { stub, req } = cronTickRequest(origin, { PhpRuntime: env.PHP_RUNTIME, build });
	const work = stub.fetch(req).then(async (res) => {
		const snippet = await res.text().catch(() => '');
		console.log(
			'@event cron-tick ' +
				JSON.stringify({
					ok: res.ok,
					status: res.status,
					scheduledTime: event && event.scheduledTime,
					cron: event && event.cron,
					body: snippet.slice(0, 200),
				}),
		);
		if (!res.ok) throw new Error(`cron-tick: HTTP ${res.status}`);
	});
	ctx.waitUntil(work);
}
// #1152 proof (strummer, cf759hx deploy 2): the readback said ok while the legs still ran the old build. The build of
// the code that ANSWERS a request (cron) is not proof of the build that RUNS the legs. The object also reports alarm:
// the build its last alarm ran on, written at the alarm's start from that code's own baked-in BUILD_ID (never a value a
// tick sent). ok only when all three agree; no alarm on record yet is not ok.
export function cronBuildState({ worker, cron, alarm }) {
	if (!worker || !cron) return 'unknown';
	if (cron !== worker) return 'object-stale';
	if (alarm !== worker) return 'legs-stale';
	return 'ok';
}
