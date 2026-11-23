// Approach A: Workers Cron Trigger ticks a named PhpRuntime (#855). Hyperdrive only; off unless
// A_CRON=on on the Worker. Does not run runCron in the front isolate (#714).

import { pullIn } from './alarm-arm.mjs';

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

// #1215: the #969 email-due wake, handed from a request that does not own the cron to the cron object. Worker to
// PhpRuntime only (the Worker 404s the path); the header gates it inside the object.
export const EMAIL_DUE_PATH = '/_email-due';
export const EMAIL_DUE_HEADER = 'x-pf-email-due';

/**
 * #1215: where a request that queued a WooCommerce email sends the #969 wake (php/woo-edge.php, emailDue).
 * - 'local': this context owns its alarm (a b-dosql or b-do object, or the A_CRON object running a leg): #969 as before.
 * - 'a-cron': approach A, a request in the Worker (no storage) or on an overflow pool object: the cron object. Before,
 *   this case was dropped, so a queued email waited for the minute tick (12 to 122 s on cf759hl).
 * - 'none': a cron-off approach A build, or no cron object. An overflowed request is never 'local' (#1186: a pool
 *   object never arms its own alarm).
 */
export function emailDueRoute({ storage, overflowed, env }) {
	if (!env || aCronObjectOff(env)) return 'none';
	if (storage && !overflowed) return 'local';
	if (approachACronEnabled(env) && env.PHP_RUNTIME) return 'a-cron';
	return 'none';
}

/** True when this Worker is configured for the cron DO tick (not b-dosql PHP_IN_DO). */
export function approachACronEnabled(env) {
	if (!env || env.A_CRON !== 'on') return false;
	if (env.PHP_IN_DO === 'on') return false;
	return true;
}

/**
 * #1310 route (b): CRON_SELF_TICK=on, for a site where no Cron Trigger fires (a Workers for Platforms user Worker:
 * scheduled() never ran in 7 min, while a Durable Object alarm fired on time; strummer, #1310). The cron object's
 * alarm already runs every leg; the tick gave only the first arm and the pull-in of a backed-off idle alarm. With this
 * on, each Worker isolate sends ONE tick on its first site request (the same tick as scheduled()), and the idle
 * back-off is capped at one interval (cron-idle.mjs idleDecision selfTick). deploy/wfp renders it for a kind a site;
 * a deploy.sh site does not, and behaves as before (#1166). Exactly "on", and only where the cron object runs.
 */
export function cronSelfTickOn(env) {
	return !!env && env.CRON_SELF_TICK === 'on' && approachACronEnabled(env);
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

// #1360: deploy.sh wakes the cron object once after the upload, so an idle alarm parked up to IDLE_MAX_MS ahead
// (cron-idle.mjs) fires now instead of at that parked time. The route only sets the alarm. The object's own alarm
// runs the tick, on the build that alarm starts.
export const CRON_WAKE_PATH = '/_cron-wake';
export const CRON_WAKE_HEADER = 'x-pf-cron-wake';

/** 'off' answers and does not call the object. 'wake' asks the object to pull its alarm in. */
export function cronWakeRoute(env) {
	if (!approachACronEnabled(env) || !env.PHP_RUNTIME) return 'off';
	return 'wake';
}

/**
 * Pull the cron alarm in to now, through pullIn (interval 0). Idempotent: an alarm already at or before now, or none,
 * is left as pullIn leaves it. This does not run a cron leg.
 */
export async function wakeCronAlarm(storage, now) {
	const r = await pullIn(storage, now, 0, 'cron-wake');
	const at = await storage.getAlarm();
	return {
		ok: true,
		pulled: r.pulled === true,
		at: at === null || at === undefined ? null : Number(at),
		was: r.pulled ? Number(r.was) : null,
	};
}

/** The cron object's answer. No token, or not this wake: the existing 403. Cron off: the alarm is not touched. */
export async function cronObjectWake({ env, storage, now, method, wakeHeader, spikeOk }) {
	if (method !== 'POST' || wakeHeader !== '1' || !spikeOk) return { status: 403, body: null };
	if (!approachACronEnabled(env)) return { status: 200, body: { ok: false, cron: 'off' } };
	return { status: 200, body: await wakeCronAlarm(storage, now) };
}
