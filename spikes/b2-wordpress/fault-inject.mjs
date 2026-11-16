// #730 (#589 B): the operator-only post-INSERT fault injector. A MEASUREMENT for throwaway sites only.
//
// #589's decision needs the rolled-back share of REST writes killed AFTER their write, and natural memory kills
// land before the INSERT (run6b, run7, run7c: 0, 0 and 3 post-write kills against a floor of 20). With this, a
// chosen request is killed right after its INSERT into wp_posts commits, so every injected kill is post-write.
//
// Armed only when ALL hold (faultArmed): the site var FAULT_INJECT is "after-insert" (rendered only with
// THROWAWAY=1 and never for a live site, deploy/fault-inject.sh, in both emitters), the request carries the
// spike token, and it sends x-pf-fault: after-insert. index.js arms it per object request and fires it once, in
// sqlStatement, after the statement (and the frame's opening transaction) returned.
//
// The kill is the NATURAL one: allocate and touch memory, holding every chunk, until the platform resets the
// isolate (outcome exceededMemory), the way /_headroom ends an isolate (headroom.mjs). Not a PHP error and not a
// JS throw, so the platform's own reset path runs: the gateway's x-isolate-reset: memory, the write-loss 500, the
// next isolate's recover(), the /_frame probe. If the isolate is still alive at the cap, the caller logs
// fault-not-killed and the request goes on; the measurement then counts it as answered, never as a kill.

export const FAULT_HEADER = 'x-pf-fault';
export const FAULT_AFTER_INSERT = 'after-insert';

/** True only with the site var, the spike token (the boolean from the object's own check) and the header. */
export function faultArmed(env, spikeOk, headers) {
	return Boolean(env) && env.FAULT_INJECT === FAULT_AFTER_INSERT && spikeOk === true && Boolean(headers) && headers.get(FAULT_HEADER) === FAULT_AFTER_INSERT;
}

const TARGET = /^\s*INSERT\s+INTO\s+[`"]?wp_posts[`"]?\s*\(/i;
/** The request's INSERT into wp_posts (the page or post itself) that changed a row. */
export function isFaultTarget(sql, reply) {
	return TARGET.test(String(sql || '')) && Boolean(reply) && reply.ok === true && Number(reply.changes) > 0;
}

/**
 * Allocate chunkMiB buffers, touch each, hold each in `held`, until capMiB. A RangeError (one allocation refused)
 * is counted and the loop goes on: only the platform's reset may end it. Returns { killed: false, mib, throws }
 * when the isolate is still alive at the cap (in a test, or if the platform did not reset it).
 */
export function exhaustMemory({ alloc = (n) => new ArrayBuffer(n), held = [], capMiB = 4096, chunkMiB = 4 } = {}) {
	let mib = 0;
	let throws = 0;
	while (mib < capMiB) {
		try {
			const b = alloc(chunkMiB * 1048576);
			new Uint8Array(b).fill(1);
			held.push(b);
			mib += chunkMiB;
		} catch {
			throws++;
			if (throws > 64) break;
		}
	}
	return { killed: false, mib, throws };
}
