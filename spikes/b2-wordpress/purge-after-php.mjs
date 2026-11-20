// #1007: the page-cache purge a PHP answer asked for, after PHP has answered (#935, #944).
// The answer is always returned. A purge that throws is never swallowed: it is logged, and asked once more
// off the response path (ctx.waitUntil), after the caller has freed the PHP runtime on a reset. The retry's
// outcome is its own structured line, so a lost purge can be counted (m: purge-retry).
import { classifyObjectError, isResetKind } from './object-error.mjs';

/**
 * Ask for the purge. Returns { header, resetKind, retry }:
 *   header     the x-cache-purge value when the ask worked (scheduled, coalesced, front), else null;
 *   resetKind  'memory' or 'storage' when the ask threw on a platform reset (the caller drops the runtime);
 *   retry      when the ask threw: a function the caller calls AFTER its cleanup. It hands one more ask to
 *              ctx.waitUntil and returns that promise (it never throws). Null when the ask worked.
 */
export async function askPurgeAfterAnswer(ctx, path, log = (o) => console.log(JSON.stringify(o))) {
	try {
		return { header: await ctx.requestPurge(), resetKind: null, retry: null };
	} catch (e) {
		const kind = classifyObjectError(e);
		log({ m: 'purge', failed: String((e && e.message) || e).slice(0, 200), kind, path });
		const retry = () => {
			const p = Promise.resolve()
				.then(() => ctx.requestPurge())
				.then((header) => log({ m: 'purge-retry', ok: true, header, path }))
				.catch((e2) => log({ m: 'purge-retry', ok: false, failed: String((e2 && e2.message) || e2).slice(0, 200), kind: classifyObjectError(e2), path }));
			if (ctx.waitUntil) ctx.waitUntil(p);
			return p;
		};
		return { header: null, resetKind: isResetKind(kind) ? kind : null, retry };
	}
}
