// Approach A: Workers Cron Trigger ticks a named PhpRuntime (#855). Hyperdrive only; off unless
// A_CRON=on on the Worker. Does not run runCron in the front isolate (#714).

export const CRON_OBJECT_NAME = 'cron';
export const CRON_TICK_PATH = '/_cron-tick';
export const CRON_TICK_HEADER = 'x-pf-cron-tick';

/** True when this Worker is configured for the cron DO tick (not b-dosql PHP_IN_DO). */
export function approachACronEnabled(env) {
	if (!env || env.A_CRON !== 'on') return false;
	if (env.PHP_IN_DO === 'on') return false;
	return true;
}

/** A POST the site Worker sends to the cron object (never a public route). */
export function cronTickRequest(origin, { PhpRuntime, objectName = CRON_OBJECT_NAME } = {}) {
	if (!PhpRuntime || typeof PhpRuntime.idFromName !== 'function') throw new Error('cron: no PHP_RUNTIME binding');
	const id = PhpRuntime.idFromName(objectName);
	const stub = PhpRuntime.get(id);
	const req = new Request(`https://do.internal${CRON_TICK_PATH}`, {
		method: 'POST',
		headers: { 'x-wp-public-origin': origin, [CRON_TICK_HEADER]: '1' },
	});
	return { stub, req };
}

/**
 * scheduled() handler: waitUntil a tick on the cron PhpRuntime. Caller passes siteOrigin(env, url)
 * because index.js owns that helper.
 */
export async function approachACronScheduled(event, env, ctx, siteOrigin) {
	if (!approachACronEnabled(env) || !env.PHP_RUNTIME) return;
	const origin = siteOrigin(env, new URL(String(env.SITE_ORIGIN || 'https://localhost/')));
	const { stub, req } = cronTickRequest(origin, { PhpRuntime: env.PHP_RUNTIME });
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