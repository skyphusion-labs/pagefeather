// #390 (corrected 2026-11-20): the idle gate for the cron leg. An idle site's 60 s alarm cold-booted PHP on most ticks
// (about 1.9 s CPU each, measured on site-pf724l0) to run a pass with nothing due. This decides from the site's OWN
// state, before any PHP boot:
//   - WP-Cron: the `cron` option (PHP serialized: timestamp => hook => event). The Action Scheduler runner hook is
//     ignored here: the cron leg runs Action Scheduler itself (its as_pass), judged by the next line;
//   - Action Scheduler: the earliest pending action's scheduled_date_gmt.
// Anything due, anything unreadable, or an email rush: the leg runs (today's behaviour). Nothing due: no boot, and the
// alarm backs off (2x the interval per idle tick, at most IDLE_MAX_MS), never past the next due event and never sooner
// than the normal interval. A request pulls a backed-off alarm back to the normal interval (index.js pullIn).
export const IDLE_MAX_MS = 5 * 60 * 1000;
export const AS_RUNNER_HOOK = 'action_scheduler_run_queue';
export const IDLE_KEY = 'cron-idle';

/** A minimal PHP unserialize: arrays (as plain objects), ints, floats, strings (byte lengths), booleans, null. undefined when not exact. */
export function phpUnserialize(input) {
	if (typeof input !== 'string') return undefined;
	const b = new TextEncoder().encode(input);
	const dec = new TextDecoder();
	let i = 0;
	const readTo = (ch) => {
		const j = b.indexOf(ch.charCodeAt(0), i);
		if (j < 0) throw new Error('eof');
		const s = dec.decode(b.subarray(i, j));
		i = j + 1;
		return s;
	};
	const expect = (ch) => {
		if (b[i] !== ch.charCodeAt(0)) throw new Error('expected ' + ch);
		i++;
	};
	const value = () => {
		const t = String.fromCharCode(b[i]);
		if (t === 'N') { i++; expect(';'); return null; }
		i++;
		expect(':');
		if (t === 'i') { const v = readTo(';'); if (!/^-?\d+$/.test(v)) throw new Error('int'); return Number(v); }
		if (t === 'd') { const v = Number(readTo(';')); if (Number.isNaN(v)) throw new Error('float'); return v; }
		if (t === 'b') { const v = readTo(';'); if (v !== '0' && v !== '1') throw new Error('bool'); return v === '1'; }
		if (t === 's') {
			const n = Number(readTo(':'));
			expect('"');
			if (!(n >= 0) || i + n > b.length) throw new Error('len');
			const s = dec.decode(b.subarray(i, i + n));
			i += n;
			expect('"');
			expect(';');
			return s;
		}
		if (t === 'a') {
			const n = Number(readTo(':'));
			expect('{');
			const o = {};
			for (let k = 0; k < n; k++) {
				const key = value();
				if (typeof key !== 'number' && typeof key !== 'string') throw new Error('key');
				o[key] = value();
			}
			expect('}');
			return o;
		}
		throw new Error('type ' + t);
	};
	try {
		const v = value();
		return i === b.length ? v : undefined;
	} catch {
		return undefined;
	}
}

/** WP-Cron's state from the cron option: { due, next } (next in seconds, or null), or null when unreadable. nowSec in seconds. */
export function wpCronState(optionValue, nowSec) {
	const o = phpUnserialize(optionValue);
	if (!o || typeof o !== 'object') return null;
	let next = null;
	for (const [k, hooks] of Object.entries(o)) {
		if (!/^\d+$/.test(k) || !hooks || typeof hooks !== 'object') continue;
		const names = Object.keys(hooks).filter((h) => h !== AS_RUNNER_HOOK);
		if (!names.length) continue;
		const ts = Number(k);
		if (next === null || ts < next) next = ts;
	}
	return { due: next !== null && next <= nowSec, next };
}

/** Action Scheduler's scheduled_date_gmt ('Y-m-d H:i:s', UTC) as ms, or null. */
export function parseGmt(s) {
	const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s || ''));
	if (!m || m[1] === '0000') return null;
	return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/**
 * The gate. wp: wpCronState (or null), as: { known, next (ms or null) }, emailRush, streak (idle ticks so far).
 * Returns { idle, alarmAt } (alarmAt only when idle).
 */
export function idleDecision({ now, intervalMs, streak = 0, emailRush = false, wp, as }) {
	if (emailRush || !wp || !as || !as.known) return { idle: false };
	if (wp.due) return { idle: false };
	if (as.next !== null && as.next !== undefined && as.next <= now) return { idle: false };
	const back = Math.min(IDLE_MAX_MS, intervalMs * 2 ** (Math.max(0, streak) + 1));
	let at = now + back;
	const nexts = [wp.next !== null && wp.next !== undefined ? wp.next * 1000 : null, as.next].filter((x) => x !== null && x !== undefined);
	for (const n of nexts) if (n < at) at = n;
	if (at < now + intervalMs) at = now + intervalMs;
	return { idle: true, alarmAt: at };
}
