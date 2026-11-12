// The cron holds off while a database import is in progress (measured 2026-11-12).
//
// Every /_dbimport part asks for a page-cache purge, and that arms the object's alarm. The
// alarm runs the cron (Action Scheduler and WP-Cron), which boots PHP and loads WordPress and
// WooCommerce INSIDE the object, between two import parts, on a half-loaded database. On
// fdprobe1112a (the 2609-product sample store) the cron ran at 03:55:52Z, mid-import, got
// "Error establishing a database connection", and the next part (10) failed with "isolate
// exceeded its memory limit". The ggc-test snapshot restore at 03:12:59Z had the same race.
//
// So each /_dbimport part stores "held until now + IMPORT_HOLD_MS", and the alarm skips the
// cron while that time is in the future. The hold ends by itself after the last part.
export const IMPORT_HOLD_KEY = 'import-hold-until';
export const IMPORT_HOLD_MS = 120 * 1000;

/** Is the cron held? `until` is the stored hold end (ms), or undefined. */
export function cronHeld(until, now) {
	return Number(until || 0) > now;
}
