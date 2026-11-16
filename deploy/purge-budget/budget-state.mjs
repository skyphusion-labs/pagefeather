// #699 part B, step 1 (red first): a budget that grants everything. The test above must fail on it.
export const RATE_PER_MIN = 4;
export const BURST = 20;
export const PAUSE_MS = 12000;
export const STALE_MS = 60000;
export function acquire(st, site, now) {
	return { st: { ...(st || {}), queue: [] }, grant: true, retryAt: null };
}
export function refused(st) {
	return { st: { ...(st || {}) } };
}
