// #1241: preconditions that a CI step supplies and a plain `node --test` does not.
// Missing and CI unset: skip, with the reason. Missing and CI set: fail, with the
// same reason, so a workflow that drops the flag cannot go green. Present: run.

export const REASON_GC = 'needs node --expose-gc';
export const REASON_LEAN = 'needs the lean loader (node --import ./spikes/b2-wordpress/tests/fixtures/lean/register.mjs)';
export const REASON_LAZY = 'needs a lazy-body engine';
export const REASON_MAGIC = 'needs MAGIC_FILE';

export function ciIsSet() {
	return process.env.CI != null && process.env.CI !== '';
}

export class PreconditionSkip extends Error {
	constructor(reason) {
		super(reason);
		this.reason = reason;
		this.preconditionSkip = true;
	}
}

// The gate. present: the precondition holds and the test runs.
export function enforce(present, reason) {
	if (present) return;
	if (!ciIsSet()) throw new PreconditionSkip(reason);
	throw new Error(reason);
}

// gate is null when the test should run, or { reason } when it should not.
// Returns true when the test was skipped. The caller must return.
export function applyGate(t, gate) {
	if (!gate) return false;
	try {
		enforce(false, gate.reason);
	} catch (err) {
		if (err && err.preconditionSkip) {
			t.skip(err.reason);
			return true;
		}
		throw err;
	}
	return false;
}

export function needGc() {
	return typeof globalThis.gc === 'function' ? null : { reason: REASON_GC };
}

// The lean loader (node --import .../register.mjs) is what makes mysql-lean.js
// an ES module with a named LeanMysql export. Without it the import throws.
export async function needLeanLoader() {
	try {
		const mod = await import('../mysql-lean.js');
		if (typeof mod.LeanMysql === 'function') return null;
	} catch { /* the loader is not registered */ }
	return { reason: REASON_LEAN };
}
